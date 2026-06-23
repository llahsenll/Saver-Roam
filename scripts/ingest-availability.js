// scripts/ingest-availability.js
// Runs directly on GitHub Actions runner — no Vercel handler wrapper needed.
// Logic identical to /api/ingest-availability.js.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PAGE_COUNT = 500;

function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbFetchJson(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function getExchangeRates() {
  const r = await fetch(`${VIATOR_BASE}/exchange-rates`, {
    method: 'POST',
    headers: {
      'exp-api-key': VIATOR_KEY,
      'Accept': 'application/json;version=2.0',
      'Accept-Language': 'en-US',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ targetCurrency: 'USD' }),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  const rateMap = {};
  (data?.rates || []).forEach(entry => {
    if (entry?.sourceCurrency && entry?.targetCurrency === 'USD' && typeof entry.rate === 'number') {
      rateMap[entry.sourceCurrency] = entry.rate;
    }
  });
  return rateMap;
}

const LOCK_STALE_MS = 70000;

async function acquireLock() {
  const rows = await sbFetchJson(
    `${SUPABASE_URL}/ingest_meta?select=availability_lock_at&id=eq.1`,
    { headers: sbHeaders() }
  );
  const lockAt = rows?.[0]?.availability_lock_at ? new Date(rows[0].availability_lock_at).getTime() : null;
  if (lockAt && (Date.now() - lockAt) < LOCK_STALE_MS) return false;
  await fetch(`${SUPABASE_URL}/ingest_meta?id=eq.1`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ availability_lock_at: new Date().toISOString() }),
  });
  return true;
}

async function releaseLock() {
  await fetch(`${SUPABASE_URL}/ingest_meta?id=eq.1`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ availability_lock_at: null }),
  });
}

// --- MAIN ---
(async () => {
  let pageCount = 0;
  let schedulesSeen = 0;
  let matchedCount = 0;
  let updatedCount = 0;
  let skippedNoPriceCount = 0;
  let skippedNoRateCount = 0;
  let lockAcquired = false;

  try {
    lockAcquired = await acquireLock();
    if (!lockAcquired) {
      console.log('Another ingest-availability run is in progress. Exiting.');
      process.exit(0);
    }

    const metaRows = await sbFetchJson(
      `${SUPABASE_URL}/ingest_meta?select=id,availability_cursor,availability_last_synced_at&id=eq.1`,
      { headers: sbHeaders() }
    );
    const meta = metaRows?.[0] || null;
    let cursor = meta?.availability_cursor || null;
    const lastSyncedAt = meta?.availability_last_synced_at || null;

    console.log(`Availability — cursor: ${cursor ? 'yes' : 'no'}, lastSyncedAt: ${lastSyncedAt}`);

    const rateMap = await getExchangeRates();
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ count: String(PAGE_COUNT) });
      if (cursor) {
        params.set('cursor', cursor);
      } else if (lastSyncedAt) {
        params.set('modifiedSince', lastSyncedAt);
      }

      console.log(`Calling Viator availability: ?${params.toString().substring(0, 80)}`);

      const response = await fetch(
        `${VIATOR_BASE}/availability/schedules/modified-since?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'exp-api-key': VIATOR_KEY,
            'Accept': 'application/json;version=2.0',
            'Accept-Language': 'en-US',
          },
        }
      );

      const bodyText = await response.text();
      const data = bodyText ? JSON.parse(bodyText) : null;

      if (!response.ok) throw new Error(`Viator ${response.status}: ${bodyText.slice(0, 500)}`);

      const schedules = data?.availabilitySchedules || [];
      schedulesSeen += schedules.length;
      pageCount += 1;

      if (schedules.length > 0) {
        const codes = schedules.map(s => s.productCode).filter(Boolean);
        const inList = codes.map(c => encodeURIComponent(c)).join(',');
        const existing = await sbFetchJson(
          `${SUPABASE_URL}/tours_raw?select=product_code&product_code=in.(${inList})`,
          { headers: sbHeaders() }
        );
        const existingSet = new Set((existing || []).map(r => r.product_code));

        for (const schedule of schedules) {
          if (!existingSet.has(schedule.productCode)) continue;
          matchedCount += 1;

          const fromPrice = schedule?.summary?.fromPrice;
          const currency = schedule?.currency;

          if (typeof fromPrice !== 'number') { skippedNoPriceCount++; continue; }

          const rate = rateMap[currency];
          if (typeof rate !== 'number') { skippedNoRateCount++; continue; }

          const priceUsd = Math.round(fromPrice * rate * 100) / 100;

          await fetch(
            `${SUPABASE_URL}/tours_raw?product_code=eq.${encodeURIComponent(schedule.productCode)}`,
            {
              method: 'PATCH',
              headers: sbHeaders({ Prefer: 'return=minimal' }),
              body: JSON.stringify({
                price_jpy: fromPrice,
                price_usd: priceUsd,
                price_currency: currency,
              }),
            }
          );
          updatedCount += 1;
        }
      }

      const nextCursor = data?.nextCursor || null;
      hasMore = !!nextCursor;

      const metaUpdate = hasMore
        ? { availability_cursor: nextCursor }
        : { availability_cursor: null, availability_last_synced_at: new Date().toISOString() };

      await fetch(`${SUPABASE_URL}/ingest_meta?id=eq.1`, {
        method: 'PATCH',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify(metaUpdate),
      });

      cursor = nextCursor;

      if (pageCount % 20 === 0) {
        console.log(`Page ${pageCount}: ${schedulesSeen} seen, ${matchedCount} matched, ${updatedCount} updated`);
      }
    }

    console.log(`Done. Pages: ${pageCount}, Seen: ${schedulesSeen}, Matched: ${matchedCount}, Updated: ${updatedCount}, No price: ${skippedNoPriceCount}, No rate: ${skippedNoRateCount}`);

  } catch (error) {
    console.error('Availability ingest failed:', error);
    process.exit(1);
  } finally {
    if (lockAcquired) await releaseLock().catch(() => {});
  }
})();
