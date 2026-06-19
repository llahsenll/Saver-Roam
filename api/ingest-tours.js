// /api/ingest-tours.js
// Vercel daily cron — pulls Japan tours from Viator → saves to Supabase tours_raw
// Runs daily at 2am UTC via vercel.json cron config

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; // https://yejleykbjsdjwhjmuwsw.supabase.co/rest/v1
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Japan destination IDs on Viator
const JAPAN_DESTINATION_IDS = ['334', '479', '480', '481', '482', '483'];

// Supabase REST helper
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

// Viator GET helper — /products/modified-since is a GET with query params
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

// Viator POST helper — for exchange-rates
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

// Check if ingest_meta has a cursor saved (means initial ingestion already started)
async function getIngestState() {
  try {
    const rows = await supabase('/ingest_meta?select=last_ingested_at&limit=1');
    if (rows && rows.length > 0 && rows[0].last_ingested_at) {
      return { isFirstRun: false, lastIngestedAt: rows[0].last_ingested_at };
    }
  } catch (e) {
    console.log('No ingest_meta found — first run');
  }
  return { isFirstRun: true, lastIngestedAt: null };
}

async function setLastIngestTimestamp(ts) {
  await supabase('/ingest_meta', 'POST', { id: 1, last_ingested_at: ts });
}

// Get JPY→USD rate
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
  const destId = String(tour.destinations?.[0]?.ref || '');
  return JAPAN_DESTINATION_IDS.some(id => destId.startsWith(id)) ||
    JSON.stringify(tour.destinations || '').includes('Japan');
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

    // Get JPY→USD rate
    const jpyRate = await getJpyToUsdRate();
    log.push(`JPY→USD rate: ${jpyRate}`);

    // Paginate through /products/modified-since
    // First run: only send count=500 (no modifiedSince, no cursor) per Viator docs
    // Subsequent runs: send modifiedSince= last timestamp
    let cursor = null;
    let pageCount = 0;
    const MAX_PAGES = 50;

    do {
      let url;
      if (pageCount === 0 && isFirstRun) {
        // Initial ingestion — count only, no modifiedSince
        url = `/products/modified-since?count=500`;
      } else if (pageCount === 0 && !isFirstRun) {
        // Delta update — use modifiedSince
        url = `/products/modified-since?count=500&modifiedSince=${encodeURIComponent(lastIngestedAt)}`;
      } else {
        // Pagination — use cursor only
        url = `/products/modified-since?count=500&cursor=${encodeURIComponent(cursor)}`;
      }

      const data = await viatorGet(url);
      const products = data.products || [];
      cursor = data.nextCursor || null;
      pageCount++;

      log.push(`Page ${pageCount}: ${products.length} products, hasMore=${!!cursor}`);

      const upsertBatch = [];

      for (const tour of products) {
        if (!isJapanTour(tour)) {
          skipped++;
          continue;
        }

        if (tour.status === 'INACTIVE' || tour.status === 'DEACTIVATED') {
          try {
            await supabase(
              `/tours_raw?product_code=eq.${tour.productCode}`,
              'PATCH',
              { viator_status: 'INACTIVE', modified_at: new Date().toISOString() }
            );
            deactivated++;
          } catch (e) {
            console.error('Failed to deactivate:', tour.productCode, e.message);
          }
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

      if (upsertBatch.length > 0) {
        await supabase('/tours_raw', 'POST', upsertBatch);
        inserted += upsertBatch.length;
        log.push(`Upserted ${upsertBatch.length} Japan tours`);
      }

      // Safety: stop after MAX_PAGES pages on first run (resume next day via cursor)
      if (pageCount >= MAX_PAGES) {
        log.push(`Hit MAX_PAGES limit (${MAX_PAGES}). Will continue tomorrow.`);
        break;
      }

    } while (cursor);

    await setLastIngestTimestamp(startedAt);

    return res.status(200).json({
      success: true,
      started_at: startedAt,
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
