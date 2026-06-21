// /api/ingest-availability.js
//
// Syncs pricing onto already-ingested Japan tours in tours_raw.
// Per Viator certification: /availability/schedules/modified-since is the ONLY
// endpoint approved for bulk pricing ingestion (NOT /availability/schedules/{code}).
// Product and availability cursors are NOT compatible -> this uses its own
// cursor columns on ingest_meta (availability_cursor, availability_last_synced_at),
// separate from the product-ingestion cursor/last_ingested_at columns.
//
// This walks the GLOBAL availability catalog (no Japan/destination filter exists
// on this endpoint), but only WRITES to rows that already exist in tours_raw
// (i.e. tours that already passed the Japan + ACTIVE filter in ingest-tours.js).
// Non-matching product codes are skipped, never inserted.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TIME_BUDGET_MS = 55000; // GitHub Actions has no proxy timeout — sized to Vercel's ~60s function ceiling instead
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
    // CRITICAL: the response contains one entry per (sourceCurrency, targetCurrency) pair,
    // e.g. JPY->CLP, JPY->EUR, JPY->PEN, JPY->USD all exist simultaneously. Must filter by
    // targetCurrency === 'USD' or this silently grabs whichever JPY-source entry happens to
    // appear last in the array (bug found 2026-06-20: was grabbing JPY->PEN instead of JPY->USD).
    if (entry?.sourceCurrency && entry?.targetCurrency === 'USD' && typeof entry.rate === 'number') {
      rateMap[entry.sourceCurrency] = entry.rate;
    }
  });
  return rateMap;
}

// --- Concurrency lock -------------------------------------------------------
// Own lock column, completely separate from ingest-tours.js's lock — these two
// scripts are independent pipelines and never block each other. This only
// prevents two overlapping runs of THIS script. Stale-after 70s (longer than
// the 55s time budget) so a crashed run can't permanently block future runs.
const LOCK_STALE_MS = 70000;

async function acquireLock() {
  const rows = await sbFetchJson(
    `${SUPABASE_URL}/ingest_meta?select=availability_lock_at&id=eq.1`,
    { headers: sbHeaders() }
  );
  const lockAtRaw = rows?.[0]?.availability_lock_at;
  const lockAt = lockAtRaw ? new Date(lockAtRaw).getTime() : null;
  if (lockAt && (Date.now() - lockAt) < LOCK_STALE_MS) {
    return false; // another run is actively in progress
  }
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
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  const startTime = Date.now();
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
      return res.status(409).json({
        success: false,
        already_running: true,
        error: 'Another ingest-availability run is still in progress (started within the last 70s). Wait for it to finish, then try again.',
      });
    }

    // 1. Load meta row
    const metaRows = await sbFetchJson(
      `${SUPABASE_URL}/ingest_meta?select=id,availability_cursor,availability_last_synced_at&id=eq.1`,
      { headers: sbHeaders() }
    );
    const meta = metaRows?.[0] || null;

    let cursor = meta?.availability_cursor || null;
    const lastSyncedAt = meta?.availability_last_synced_at || null;

    // 2. Exchange rates (once per invocation)
    const rateMap = await getExchangeRates();

    let hasMore = true;

    while (hasMore && (Date.now() - startTime) < TIME_BUDGET_MS) {
      const params = new URLSearchParams({ count: String(PAGE_COUNT) });
      if (cursor) {
        params.set('cursor', cursor);
      } else if (lastSyncedAt) {
        params.set('modifiedSince', lastSyncedAt);
      }
      // else: very first run ever -> count only, no cursor/modifiedSince

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

      if (!response.ok) {
        throw new Error(`Viator ${response.status}: ${bodyText.slice(0, 500)}`);
      }

      const schedules = data?.availabilitySchedules || [];
      schedulesSeen += schedules.length;
      pageCount += 1;

      if (schedules.length > 0) {
        const codes = schedules.map(s => s.productCode).filter(Boolean);

        // Find which of these codes already exist in tours_raw
        const inList = codes.map(c => encodeURIComponent(c)).join(',');
        const existing = await sbFetchJson(
          `${SUPABASE_URL}/tours_raw?select=product_code&product_code=in.(${inList})`,
          { headers: sbHeaders() }
        );
        const existingSet = new Set((existing || []).map(r => r.product_code));

        for (const schedule of schedules) {
          if (!existingSet.has(schedule.productCode)) continue; // not one of ours, skip
          matchedCount += 1;

          const fromPrice = schedule?.summary?.fromPrice;
          const currency = schedule?.currency;

          if (typeof fromPrice !== 'number') {
            skippedNoPriceCount += 1;
            continue;
          }

          const rate = rateMap[currency];
          if (typeof rate !== 'number') {
            skippedNoRateCount += 1;
            continue; // unknown currency - still leave price_jpy update below if you want native-only
          }

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

      // Checkpoint cursor after EVERY page, same pattern as ingest-tours.js
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
    }

    return res.status(200).json({
      pages_fetched: pageCount,
      schedules_seen: schedulesSeen,
      matched_existing_tours: matchedCount,
      updated: updatedCount,
      skipped_no_price: skippedNoPriceCount,
      skipped_unknown_currency: skippedNoRateCount,
      has_more: hasMore,
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message,
      pages_fetched: pageCount,
      schedules_seen: schedulesSeen,
      matched_existing_tours: matchedCount,
      updated: updatedCount,
    });
  } finally {
    if (lockAcquired) {
      await releaseLock().catch(() => {}); // best-effort cleanup, never throw from here
    }
  }
}
