// /api/ingest-tours.js
// Vercel daily cron — pulls Japan tours from Viator → saves to Supabase tours_raw
// Runs daily at 2am UTC via vercel.json cron config

const VIATOR_BASE = 'https://api.sandbox.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; // https://yejleykbjsdjwhjmuwsw.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Japan destination IDs on Viator
// 334 = Japan (country), 479 = Tokyo, 480 = Kyoto, 481 = Osaka
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
  // 204 No Content (upsert success) returns no body
  if (res.status === 204) return null;
  return res.json();
}

// Viator REST helper
async function viator(path, method = 'GET', body = null) {
  const res = await fetch(`${VIATOR_BASE}${path}`, {
    method,
    headers: {
      'exp-api-key': VIATOR_KEY,
      'Accept': 'application/json;version=2.0',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(120000), // 120s timeout per Viator requirement
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Viator error ${res.status}: ${err}`);
  }
  return res.json();
}

// Get the last successful ingestion timestamp from Supabase
// We store it in a simple meta table row
async function getLastIngestTimestamp() {
  try {
    const rows = await supabase('/ingest_meta?select=last_ingested_at&limit=1');
    if (rows && rows.length > 0 && rows[0].last_ingested_at) {
      return rows[0].last_ingested_at;
    }
  } catch (e) {
    console.log('No ingest_meta found, will do initial seed');
  }
  // First run — backdate 90 days to seed existing Japan tours
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  return ninetyDaysAgo.toISOString();
}

// Save last successful ingestion timestamp
async function setLastIngestTimestamp(ts) {
  await supabase('/ingest_meta', 'POST', { id: 1, last_ingested_at: ts });
}

// Get USD exchange rate for JPY
async function getJpyToUsdRate() {
  const data = await viator('/exchange-rates', 'POST', { targetCurrency: 'USD' });
  const rate = data.rates?.find(r => r.sourceCurrency === 'JPY' && r.targetCurrency === 'USD');
  return rate ? rate.rate : null;
}

// Extract max group size from pricingDetails (adult ageBand, highest maxTravelers)
function extractMaxGroupSize(pricingDetails) {
  if (!pricingDetails || !Array.isArray(pricingDetails)) return null;
  const adultBands = pricingDetails.filter(p => p.ageBand === 'ADULT');
  if (!adultBands.length) return null;
  return Math.max(...adultBands.map(p => p.maxTravelers || 0)) || null;
}

// Extract duration in minutes from tour object
function extractDuration(tour) {
  return (
    tour.itinerary?.duration?.fixedDurationInMinutes ||
    tour.itinerary?.duration?.variableDurationFromMinutes ||
    null
  );
}

// Check if tour is Japan-related by destination
function isJapanTour(tour) {
  const destId = String(tour.destinations?.[0]?.ref || '');
  return JAPAN_DESTINATION_IDS.some(id => destId.startsWith(id)) ||
    JSON.stringify(tour.destinations || '').includes('Japan');
}

// Main ingestion function
export default async function handler(req, res) {
  // Allow manual trigger via GET or scheduled trigger
  // Vercel cron sends GET requests
  const startedAt = new Date().toISOString();
  const log = [];
  let inserted = 0;
  let updated = 0;
  let deactivated = 0;
  let skipped = 0;

  try {
    console.log('Ingest started:', startedAt);
    log.push(`Ingest started: ${startedAt}`);

    // 1. Get last ingestion timestamp (or 90 days back for first run)
    const fromTimestamp = await getLastIngestTimestamp();
    log.push(`Fetching tours modified since: ${fromTimestamp}`);
    console.log('Fetching tours modified since:', fromTimestamp);

    // 2. Get JPY→USD rate
    const jpyRate = await getJpyToUsdRate();
    log.push(`JPY→USD rate: ${jpyRate}`);

    // 3. Paginate through /products/modified-since
    let cursor = null;
    let pageCount = 0;
    const MAX_PAGES = 50; // Safety limit — each page ~100 tours = up to 5000 tours max per run

    do {
      const payload = {
        modifiedSince: fromTimestamp,
        count: 100,
        ...(cursor ? { cursor } : {}),
      };

      const data = await viator('/products/modified-since', 'POST', payload);
      const products = data.products || [];
      cursor = data.nextCursor || null;
      pageCount++;

      log.push(`Page ${pageCount}: ${products.length} products, cursor=${cursor ? 'yes' : 'none'}`);
      console.log(`Page ${pageCount}: ${products.length} products`);

      // 4. Process each product
      const upsertBatch = [];

      for (const tour of products) {
        // Skip non-Japan tours
        if (!isJapanTour(tour)) {
          skipped++;
          continue;
        }

        // Handle deactivated tours
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

        // Extract price
        const priceJpy = tour.pricingSummary?.fromPrice || null;
        const priceUsd = priceJpy && jpyRate ? Math.round(priceJpy * jpyRate * 100) / 100 : null;

        // Build record
        const record = {
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
          vetting_status: 'pending', // Only set on INSERT — existing records keep their status
        };

        upsertBatch.push(record);
      }

      // 5. Batch upsert to Supabase (merge on product_code)
      if (upsertBatch.length > 0) {
        await supabase('/tours_raw', 'POST', upsertBatch);
        inserted += upsertBatch.length;
        log.push(`Upserted ${upsertBatch.length} Japan tours from page ${pageCount}`);
      }

    } while (cursor && pageCount < MAX_PAGES);

    // 6. Save new timestamp
    await setLastIngestTimestamp(startedAt);
    log.push(`Saved new ingest timestamp: ${startedAt}`);

    const summary = {
      success: true,
      started_at: startedAt,
      from_timestamp: fromTimestamp,
      pages_fetched: pageCount,
      upserted: inserted,
      deactivated,
      skipped_non_japan: skipped,
      log,
    };

    console.log('Ingest complete:', summary);
    return res.status(200).json(summary);

  } catch (error) {
    console.error('Ingest failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      log,
    });
  }
}
