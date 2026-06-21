// /api/ingest-tours.js
// Vercel daily cron — pulls Japan tours from Viator → saves to Supabase tours_raw
//
// NOTE: price_jpy / price_usd / price_currency are NOT touched by this script.
// Pricing is owned exclusively by ingest-availability.js (the only Viator-certified
// path for bulk pricing). This script used to compute price via tour.pricingSummary
// (a field that doesn't exist on this endpoint, see build log) and would have
// overwritten good prices back to null on every re-save. Removed entirely.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Full set of 150 destination IDs under Japan's taxonomy tree (country + all
// regions/prefectures/cities/neighborhoods), pulled directly from Viator's
// /destinations endpoint on 2026-06-21. The previous hardcoded list (36 IDs)
// only covered some prefecture/region-level tags and was missing nearly every
// city-level ID -- including Tokyo (334), Kyoto (332), Osaka (333), Yokohama,
// Sapporo, Hiroshima, Nagoya, Fukuoka, Kobe, Nara, Hakone, Nikko, Kamakura,
// Asakusa, Shibuya, etc. Since most products are tagged at the city level,
// this was silently excluding the vast majority of real Japan tours.
const JAPAN_DEST_IDS = new Set([
  16,332,333,334,4659,4660,4661,4663,4665,4666,4667,4668,
  4687,4691,4693,4697,4699,4701,5558,5559,5614,23311,23404,23523,
  25315,25550,25611,25747,25943,26734,27171,27432,28079,28080,50143,50146,
  50147,50148,50149,50150,50151,50152,50153,50154,50155,50156,50157,50158,
  50159,50160,50161,50162,50163,50164,50165,50166,50167,50168,50169,50170,
  50171,50172,50173,50174,50175,50176,50177,50178,50179,50180,50181,50182,
  50183,50184,50185,50186,50187,50188,50190,50489,50510,50511,50512,50513,
  50514,50515,50516,50517,50518,50592,50594,50595,50596,50597,50598,50599,
  50600,50602,50603,50604,50608,50673,50674,50675,50676,50678,50679,50680,
  50681,50682,50683,50684,50685,50686,50687,50688,50689,50690,50821,50822,
  50823,50824,50825,50826,50827,50828,50829,50830,50831,50832,50833,50834,
  50835,50836,50837,50838,50839,50840,50885,51048,51049,51050,51051,51226,
  51239,51459,52140,59194,60411,60446
]);

// --- Image trimming -------------------------------------------------------
// Viator returns ~10 size variants per photo. We only ever need 2 on the
// site (a card/grid size and a larger detail/hero size), so we throw the
// rest away before storing. Cuts the images field by roughly 70-80%.
const CARD_TARGET_WIDTH = 400;
const HERO_TARGET_WIDTH = 720;

function pickClosestVariant(variants, targetWidth) {
  if (!variants || !variants.length) return null;
  return variants.reduce((best, v) => {
    if (!best) return v;
    return Math.abs(v.width - targetWidth) < Math.abs(best.width - targetWidth) ? v : best;
  }, null);
}

function trimImages(images) {
  if (!images || !Array.isArray(images)) return null;
  return images.map(img => {
    const variants = img.variants || [];
    const card = pickClosestVariant(variants, CARD_TARGET_WIDTH);
    const hero = pickClosestVariant(variants, HERO_TARGET_WIDTH);
    const trimmedVariants = [];
    if (card) trimmedVariants.push(card);
    if (hero && hero.url !== card?.url) trimmedVariants.push(hero);
    return {
      imageSource: img.imageSource,
      caption: img.caption,
      isCover: img.isCover,
      variants: trimmedVariants,
    };
  });
}
// ---------------------------------------------------------------------------

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

// --- Concurrency lock -------------------------------------------------------
// Prevents two overlapping runs of THIS script from racing on the same cursor.
// Stale-after 70s (longer than the 55s time budget) so a crashed run can't
// permanently block future runs.
const LOCK_STALE_MS = 70000;

async function acquireLock() {
  const rows = await supabase('/ingest_meta?select=tours_lock_at&id=eq.1');
  const lockAt = rows?.[0]?.tours_lock_at ? new Date(rows[0].tours_lock_at).getTime() : null;
  if (lockAt && (Date.now() - lockAt) < LOCK_STALE_MS) {
    return false; // another run is actively in progress
  }
  await supabase('/ingest_meta', 'POST', { id: 1, tours_lock_at: new Date().toISOString() });
  return true;
}

async function releaseLock() {
  await supabase('/ingest_meta', 'POST', { id: 1, tours_lock_at: null });
}
// -----------------------------------------------------------------------------

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
  let newInserted = 0;
  let updatedExisting = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const codes = chunk.map(r => r.product_code);
    try {
      // Check which of these codes already exist BEFORE upserting, so the
      // summary can report "actually new" vs "already had this one" instead
      // of one ambiguous combined number.
      const inList = codes.map(c => encodeURIComponent(c)).join(',');
      const existing = await supabase(`/tours_raw?select=product_code&product_code=in.(${inList})`);
      const existingSet = new Set((existing || []).map(r => r.product_code));

      await supabase('/tours_raw', 'POST', chunk);

      for (const code of codes) {
        if (existingSet.has(code)) updatedExisting++;
        else newInserted++;
      }
    } catch (e) {
      log.push(`Chunk upsert error: ${e.message}`);
    }
  }
  return { newInserted, updatedExisting };
}

export default async function handler(req, res) {
  const startedAt = new Date().toISOString();
  const log = [];
  let newInserted = 0;
  let updatedExisting = 0;
  let deactivated = 0;
  let skipped = 0;
  let totalFetched = 0;
  let pageCount = 0;
  let lockAcquired = false;

  try {
    lockAcquired = await acquireLock();
    if (!lockAcquired) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(409).send(JSON.stringify({
        success: false,
        already_running: true,
        error: 'Another ingest-tours run is still in progress (started within the last 70s). Wait for it to finish, then try again.',
      }));
    }

    log.push(`Ingest started: ${startedAt}`);

    const { isFirstRun, lastIngestedAt, savedCursor } = await getIngestState();
    log.push(`First run: ${isFirstRun}, resuming from cursor: ${savedCursor ? 'yes' : 'no'}`);

    let cursor = savedCursor;
    const MAX_PAGES = 1000; // Safety ceiling — real limit is the time budget below
    const TIME_BUDGET_MS = 55000; // GitHub Actions has no proxy timeout — sized to Vercel's ~60s function ceiling instead

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

        upsertBatch.push({
          product_code: tour.productCode,
          title: tour.title || null,
          description: tour.description || null,
          duration_minutes: extractDuration(tour),
          max_group_size: extractMaxGroupSize(tour.pricingInfo),
          // price_jpy / price_usd / price_currency intentionally omitted —
          // owned by ingest-availability.js. Omitting the keys (not setting
          // them to null) means Supabase's upsert leaves existing price data
          // untouched on conflict instead of clobbering it.
          rating: tour.reviews?.combinedAverageRating || null,
          review_count: tour.reviews?.totalReviews || null,
          images: tour.images ? JSON.stringify(trimImages(tour.images)) : null,
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
        const result = await upsertChunked(upsertBatch, log);
        newInserted += result.newInserted;
        updatedExisting += result.updatedExisting;
      }

      // Only save cursor AFTER successful page processing
      cursor = nextCursor;
      await saveState(startedAt, cursor);

      if (pageCount % 10 === 0) {
        log.push(`Page ${pageCount}: ${totalFetched} fetched, ${newInserted} new, ${updatedExisting} updated, ${deactivated} inactive, ${skipped} non-Japan`);
      }

    } while (cursor && pageCount < MAX_PAGES && (Date.now() - new Date(startedAt).getTime()) < TIME_BUDGET_MS);

    if (!cursor) {
      await saveState(startedAt, null);
      log.push('Catalog fully ingested — cursor cleared');
    }

    log.push(`Done. Pages: ${pageCount}, Fetched: ${totalFetched}, New: ${newInserted}, Updated: ${updatedExisting}, Inactive: ${deactivated}, Non-Japan: ${skipped}`);

    const summary = {
      success: true,
      first_run: isFirstRun,
      pages_fetched: pageCount,
      total_fetched: totalFetched,
      new_tours_inserted: newInserted,
      existing_tours_updated: updatedExisting,
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
      new_tours_inserted: newInserted,
      existing_tours_updated: updatedExisting,
    };
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).send(JSON.stringify(errSummary));
  } finally {
    if (lockAcquired) {
      await releaseLock().catch(() => {}); // best-effort cleanup, never throw from here
    }
  }
}
