// /api/ingest-tours.js
// Vercel daily cron — pulls Japan tours from Viator → saves to Supabase tours_raw

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Japan destination IDs — we'll log what we actually see and filter broadly
const JAPAN_DEST_IDS = ['334', '479', '480', '481', '482', '483'];

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
  return res.json();
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
  return res.json();
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
    const rows = await supabase('/ingest_meta?select=last_ingested_at&limit=1');
    if (rows && rows.length > 0 && rows[0].last_ingested_at) {
      return { isFirstRun: false, lastIngestedAt: rows[0].last_ingested_at };
    }
  } catch (e) {
    console.log('No ingest_meta — first run');
  }
  return { isFirstRun: true, lastIngestedAt: null };
}

async function setLastIngestTimestamp(ts) {
  await supabase('/ingest_meta', 'POST', { id: 1, last_ingested_at: ts });
}

async function getJpyToUsdRate() {
  const data = await viatorPost('/exchange-rates', { targetCurrency: 'USD' });
  const rate = data.rates?.find(r => r.sourceCurrency === 'JPY' && r.targetCurrency === 'USD');
  return rate ? rate.rate : null;
}

function extractMaxGroupSize(pricingDetails) {
  if (!pricingDetails || !Array.isArray(pricingDetails)) return null;
  const adultBands = pricingDetails.filter(p => p.ageBand === 'ADULT');
  if (!adultBands.length) return null;
  return Math.max(...adultBands.map(p => p.maxTravelers || 0)) || null;
}

function extractDuration(tour) {
  return (
    tour.itinerary?.duration?.fixedDurationInMinutes ||
    tour.itinerary?.duration?.variableDurationFromMinutes ||
    null
  );
}

function isJapanTour(tour) {
  const destStr = JSON.stringify(tour.destinations || []);
  // Match any Japan destination ID or "Japan" text in destinations
  return JAPAN_DEST_IDS.some(id => destStr.includes(`"${id}"`) || destStr.includes(`'${id}'`)) ||
    destStr.toLowerCase().includes('japan');
}

// Upsert in small chunks to avoid Supabase payload limits
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

  try {
    log.push(`Ingest started: ${startedAt}`);

    const { isFirstRun, lastIngestedAt } = await getIngestState();
    log.push(`First run: ${isFirstRun}`);

    const jpyRate = await getJpyToUsdRate();
    log.push(`JPY→USD rate: ${jpyRate}`);

    let cursor = null;
    let pageCount = 0;
    const MAX_PAGES = 3; // Small limit for testing — increase after confirmed working

    do {
      let url;
      if (pageCount === 0 && isFirstRun) {
        url = `/products/modified-since?count=100`;
      } else if (pageCount === 0 && !isFirstRun) {
        url = `/products/modified-since?count=100&modifiedSince=${encodeURIComponent(lastIngestedAt)}`;
      } else {
        url = `/products/modified-since?count=100&cursor=${encodeURIComponent(cursor)}`;
      }

      const data = await viatorGet(url);
      const products = data.products || [];
      cursor = data.nextCursor || null;
      pageCount++;

      // Debug: log destination IDs from first page so we can verify Japan filter
      if (pageCount === 1) {
        const sampleDests = products.slice(0, 5).map(t => ({
          code: t.productCode,
          dests: t.destinations?.map(d => d.ref) || []
        }));
        log.push(`Sample destinations page 1: ${JSON.stringify(sampleDests)}`);
      }

      const upsertBatch = [];

      for (const tour of products) {
        if (tour.status === 'INACTIVE' || tour.status === 'DEACTIVATED') {
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
          max_group_size: extractMaxGroupSize(tour.pricingDetails),
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

      log.push(`Page ${pageCount}: ${products.length} fetched, ${upsertBatch.length} Japan, ${skipped} skipped`);

      if (upsertBatch.length > 0) {
        const saved = await upsertChunked(upsertBatch, log);
        inserted += saved;
        log.push(`Saved ${saved} to Supabase`);
      }

    } while (cursor && pageCount < MAX_PAGES);

    await setLastIngestTimestamp(startedAt);

    return res.status(200).json({
      success: true,
      first_run: isFirstRun,
      pages_fetched: pageCount,
      upserted: inserted,
      deactivated,
      skipped_non_japan: skipped,
      log,
    });

  } catch (error) {
    console.error('Ingest failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      log,
    });
  }
}
