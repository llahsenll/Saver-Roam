// scripts/ingest-tours.js
// Runs directly on GitHub Actions runner — no Vercel handler wrapper needed.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Supabase response not valid JSON: ${text.substring(0, 200)}`); }
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
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Viator response invalid JSON (${text.length} chars): ${text.substring(0, 200)}`); }
}

async function getIngestState() {
  try {
    const rows = await supabase('/ingest_meta?select=last_ingested_at,cursor,backfill_complete&id=eq.1&limit=1');
    if (rows && rows.length > 0) {
      const row = rows[0];
      return {
        isFirstRun: !row.last_ingested_at && !row.cursor && !row.backfill_complete,
        lastIngestedAt: row.last_ingested_at || null,
        savedCursor: row.cursor || null,
        backfillComplete: !!row.backfill_complete,
      };
    }
  } catch (e) {
    console.log('No ingest_meta row found — treating as first run.');
  }
  return { isFirstRun: true, lastIngestedAt: null, savedCursor: null, backfillComplete: false };
}

async function saveState(ts, cursor, backfillComplete) {
  const payload = {
    id: 1,
    last_ingested_at: ts,
    cursor: cursor || null,
  };
  // Only write backfill_complete if explicitly passed
  if (backfillComplete !== undefined) {
    payload.backfill_complete = backfillComplete;
  }
  await supabase('/ingest_meta', 'POST', payload);
}

const LOCK_STALE_MS = 70000;

async function acquireLock() {
  const rows = await supabase('/ingest_meta?select=tours_lock_at&id=eq.1');
  const lockAt = rows?.[0]?.tours_lock_at ? new Date(rows[0].tours_lock_at).getTime() : null;
  if (lockAt && (Date.now() - lockAt) < LOCK_STALE_MS) return false;
  await supabase('/ingest_meta', 'POST', { id: 1, tours_lock_at: new Date().toISOString() });
  return true;
}

async function releaseLock() {
  await supabase('/ingest_meta', 'POST', { id: 1, tours_lock_at: null });
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
  let newInserted = 0;
  let updatedExisting = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const codes = chunk.map(r => r.product_code);
    try {
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

// --- MAIN ---
(async () => {
  const log = [];
  let newInserted = 0;
  let updatedExisting = 0;
  let deactivated = 0;
  let skipped = 0;
  let totalFetched = 0;
  let pageCount = 0;
  let lockAcquired = false;

  const MAX_PAGES = 99999;

  try {
    lockAcquired = await acquireLock();
    if (!lockAcquired) {
      console.log('Another ingest-tours run is in progress. Exiting.');
      process.exit(0);
    }

    const { isFirstRun, lastIngestedAt, savedCursor, backfillComplete } = await getIngestState();
    console.log(`State — firstRun: ${isFirstRun}, backfillComplete: ${backfillComplete}, cursor: ${savedCursor ? 'yes' : 'no'}, modifiedSince: ${lastIngestedAt}`);

    // MODE LOGIC:
    // - isFirstRun: no row in ingest_meta at all — start fresh, no modifiedSince, no cursor
    // - !backfillComplete: backfill in progress — follow cursor across runs until exhausted
    // - backfillComplete: normal delta mode — 1 page from modifiedSince, then stop
    const isBackfill = isFirstRun || !backfillComplete;
    const isDeltaMode = backfillComplete;

    if (isDeltaMode) {
      console.log('DELTA MODE — fetching 1 page of recent changes then stopping.');
    } else {
      console.log('BACKFILL MODE — following cursor until catalog exhausted.');
    }

    let cursor = savedCursor;

    do {
      let url;
      if (!cursor && isFirstRun) {
        // Very first ever run — no modifiedSince, no cursor
        url = `/products/modified-since?count=50`;
      } else if (!cursor && isDeltaMode) {
        // Delta: use modifiedSince from last run
        url = `/products/modified-since?count=50&modifiedSince=${encodeURIComponent(lastIngestedAt)}`;
      } else if (cursor) {
        // Backfill mid-walk or delta pagination — follow cursor
        url = `/products/modified-since?count=50&cursor=${encodeURIComponent(cursor)}`;
      } else {
        // Backfill but cursor was cleared (shouldn't happen, safety fallback)
        url = `/products/modified-since?count=50`;
      }

      console.log('Calling Viator:', url);
      const data = await viatorGet(url);
      const products = data.products || [];
      const nextCursor = data.nextCursor || null;
      pageCount++;
      totalFetched += products.length;

      const upsertBatch = [];
      for (const tour of products) {
        if (tour.status !== 'ACTIVE') { deactivated++; continue; }
        if (!isJapanTour(tour)) { skipped++; continue; }
        upsertBatch.push({
          product_code: tour.productCode,
          title: tour.title || null,
          description: tour.description || null,
          duration_minutes: extractDuration(tour),
          max_group_size: extractMaxGroupSize(tour.pricingInfo),
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

      cursor = nextCursor;

      if (isDeltaMode) {
        // Delta: save timestamp, no cursor, backfill_complete stays true
        await saveState(new Date().toISOString(), null, true);
        console.log(`Delta mode: 1 page done. New: ${newInserted}, Updated: ${updatedExisting}. Stopping.`);
        break;
      } else {
        // Backfill: save cursor so next run resumes where we left off
        await saveState(new Date().toISOString(), cursor, false);
      }

      if (pageCount % 10 === 0) {
        console.log(`Page ${pageCount}: ${totalFetched} fetched, ${newInserted} new, ${updatedExisting} updated, ${deactivated} inactive, ${skipped} non-Japan`);
      }

    } while (cursor && pageCount < MAX_PAGES);

    // Backfill finished — cursor exhausted
    if (!isDeltaMode && !cursor) {
      await saveState(new Date().toISOString(), null, true);
      console.log('Backfill complete — cursor cleared, backfill_complete=true. Next runs will be delta mode.');
    }

    console.log(`Done. Pages: ${pageCount}, Fetched: ${totalFetched}, New: ${newInserted}, Updated: ${updatedExisting}, Inactive: ${deactivated}, Non-Japan: ${skipped}`);
    if (log.length) console.log('Errors:', log.join('\n'));

  } catch (error) {
    console.error('Ingest failed:', error);
    process.exit(1);
  } finally {
    if (lockAcquired) await releaseLock().catch(() => {});
  }
})();
