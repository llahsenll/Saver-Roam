// /api/debug-availability-bulk.js
// One-time check: confirms the actual shape of /availability/schedules/modified-since
// (array field name, nextCursor presence, per-item structure) before we build the
// real ingest-availability.js. Uses count=3 to keep the response small and readable.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const response = await fetch(
      `${VIATOR_BASE}/availability/schedules/modified-since?count=3`,
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

    return res.status(200).json({
      http_status: response.status,
      top_level_keys: data ? Object.keys(data) : [],
      has_nextCursor: !!data?.nextCursor,
      nextCursor_sample: data?.nextCursor || null,
      raw_response: data,
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
