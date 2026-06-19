// /api/ingest-tours.js
// Vercel daily cron — pulls Japan tours from Viator → saves to Supabase tours_raw

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const JAPAN_DEST_IDS = new Set([
  16,50147,60446,5558,50146,5614,23311,50150,50152,50151,50154,50153,50156,
  50155,50158,50157,50168,50176,50175,50178,50177,50179,50181,50180,50183,
  50182,50185,50184,50187,50186,50188,50190,50149,50148,25611,23404
]);

async function supabase(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase response not valid JSON: ${text.substring(0, 200)}`);
  }
}

async function viatorGet(path) {
  const res = await fetch(`${VIATOR_BASE}${path}`, {
    method: 'GET',
    headers: {
      'exp-api-key': VIATOR_KEY,
      'Accept': 'application/json;version=2.0',
      'Accept-Language': 'en-US',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Viator error ${res.status}: ${err}`);
  }
  // Read as text first to catch truncated responses
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Viator response truncated or invalid JSON (${text.length} chars): ${text.substring(0, 200)}`);
  }
}

async function viatorPost(path, body) {
  const res = await fetch(`${VIATOR_BASE}${path}`, {
    method: 'POST',
    headers: {
      'exp-api-key': VIATOR_KEY,
      'Accept': 'application/json;version=2.0',
      'Accept-Language': 'en-US',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Viator error ${res.status}: ${err}`);
  }
  return res.json();
}

async function getIngestState() {
  try {
    const rows = await supabase('/ingest_meta?select=last_ingested_at,cursor&limit=1');
    if (rows && rows.length > 0) {
      return {
        isFirstRun: !rows[0].last_ingested_at && !rows[0].cursor,
        lastIngestedAt: rows[0].last_ingested_at || null,
        savedCursor: rows[0].cursor || null,
      };
    }
  } catch (e) {
    console.log('No ingest_meta — first run');
  }
  return { isFirstRun: true, lastIngestedAt: null, savedCursor: null };
}

// Only save state after a SUCCESSFUL page fetch
async function saveState(ts, cursor) {
  await supabase('/ingest_meta', 'POST', {
    id: 1,
    last_ingested_at: ts,
    cursor: cursor || null,
  });
}

async function getJpyToUsdRate() {
  const data = await viatorPost('/exchange-rates', { targetCurrency: 'USD' });
  const rate = data.rates?.find(r => r.sourceCurrency === 'JPY' && r.targetCurrency === 'USD');
  return rate ? rate.rate : null;
}

function extractMaxGroupSize(pricingInfo) {
  if (!pricingInfo?.ageBands) return null;
  const adultBands = pricingInfo.ageBands.filter(p => p.ageBand === 'ADULT');
  if (!adultBands.length) return null;
  return Math.max(...adultBands.map(p => p.maxTravelersPerBooking || 0)) || null;
}

function extractDuration(tour) {
  return (
    tour.itinerary?.duration?.fixedDurationInMinutes ||
    tour.itinerary?.duration?.variableDurationFromMinutes ||
    null
  );
}

function isJapanTour(tour) {
  const dests = tour.destinations || [];
  return dests.some(d => JAPAN_DEST_IDS.has(Number(d.ref)));
}

async function upsertChunked(records, log) {
  const CHUNK_SIZE = 25;
  let saved = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    try {
      await supabase('/tours_raw', 'POST', chunk);
      saved += chunk.length;
    } catch (e) {
      log.push(`Chunk upsert error: ${e.message}`);
    }
  }
  return saved;
}

export default async function handler(req, res) {
  const startedAt = new Date().toISOString();
  const log = [];
  let inserted = 0;
  let deactivated = 0;
  let skipped = 0;
  let totalFetched = 0;
  let pageCount = 0;

  try {
    log.push(`Ingest started: ${startedAt}`);

    const { isFirstRun, lastIngestedAt, savedCursor } = await getIngestState();
    log.push(`First run: ${isFirstRun}, resuming from cursor: ${savedCursor ? 'yes' : 'no'}`);

    const jpyRate = await getJpyToUsdRate();
    log.push(`JPY→USD rate: ${jpyRate}`);

    let cursor = savedCursor;
    const MAX_PAGES = 1000; // Safety ceiling — real limit is the time budget below
    const TIME_BUDGET_MS = 55000; // Stop just under Vercel's 60s timeout, save cursor, return

    do {
      let url;
      if (!cursor && isFirstRun) {
        url = `/products/modified-since?count=50`;
      } else if (!cursor && !isFirstRun) {
        url = `/products/modified-since?count=50&modifiedSince=${encodeURIComponent(lastIngestedAt)}`;
      } else {
        url = `/products/modified-since?count=50&cursor=${encodeURIComponent(cursor)}`;
      }

      // Fetch page — if this fails, we don't save cursor (so next run retries same position)
      const data = await viatorGet(url);
      const products = data.products || [];
      const nextCursor = data.nextCursor || null;
      pageCount++;
      totalFetched += products.length;

      const upsertBatch = [];

      for (const tour of products) {
        if (tour.status !== 'ACTIVE') {
          deactivated++;
          continue;
        }
        if (!isJapanTour(tour)) {
          skipped++;
          continue;
        }

        const priceJpy = tour.pricingSummary?.fromPrice || null;
        const priceUsd = priceJpy && jpyRate ? Math.round(priceJpy * jpyRate * 100) / 100 : null;

        upsertBatch.push({
          product_code: tour.productCode,
          title: tour.title || null,
          description: tour.description || null,
          duration_minutes: extractDuration(tour),
          max_group_size: extractMaxGroupSize(tour.pricingInfo),
          price_jpy: priceJpy,
          price_usd: priceUsd,
          rating: tour.reviews?.combinedAverageRating || null,
          review_count: tour.reviews?.totalReviews || null,
          images: tour.images ? JSON.stringify(tour.images) : null,
          inclusions: tour.inclusions ? JSON.stringify(tour.inclusions) : null,
          tags: tour.tags ? JSON.stringify(tour.tags) : null,
          destination_id: tour.destinations?.[0]?.ref || null,
          affiliate_url: tour.productUrl || null,
          viator_status: 'ACTIVE',
          modified_at: new Date().toISOString(),
          vetting_status: 'pending',
        });
      }

      if (upsertBatch.length > 0) {
        const saved = await upsertChunked(upsertBatch, log);
        inserted += saved;
      }

      // Only save cursor AFTER successful page processing
      cursor = nextCursor;
      await saveState(startedAt, cursor);

      if (pageCount % 10 === 0) {
        log.push(`Page ${pageCount}: ${totalFetched} fetched, ${inserted} Japan saved, ${deactivated} inactive, ${skipped} non-Japan`);
      }

    } while (cursor && pageCount < MAX_PAGES && (Date.now() - new Date(startedAt).getTime()) < TIME_BUDGET_MS);

    if (!cursor) {
      await saveState(startedAt, null);
      log.push('Catalog fully ingested — cursor cleared');
    }

    log.push(`Done. Pages: ${pageCount}, Fetched: ${totalFetched}, Saved: ${inserted}, Inactive: ${deactivated}, Non-Japan: ${skipped}`);

    const summary = {
      success: true,
      first_run: isFirstRun,
      pages_fetched: pageCount,
      total_fetched: totalFetched,
      upserted: inserted,
      inactive_skipped: deactivated,
      non_japan_skipped: skipped,
      has_more: !!cursor,
    };
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(summary));

  } catch (error) {
    console.error('Ingest failed:', error);
    const errSummary = {
      success: false,
      error: String(error.message || error),
      pages_fetched: pageCount,
      upserted: inserted,
    };
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).send(JSON.stringify(errSummary));
  }
}
