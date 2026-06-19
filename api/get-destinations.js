// /api/get-destinations.js
// Gets all Japan destination IDs (country + all cities/regions)

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const response = await fetch(`${VIATOR_BASE}/destinations`, {
      method: 'GET',
      headers: {
        'exp-api-key': VIATOR_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
      },
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Viator error ${response.status}: ${err}` });
    }

    const data = await response.json();
    const destinations = data.destinations || [];

    // Japan country ID is 16
    const JAPAN_ID = 16;

    // Get all destinations that are children of Japan
    const japanChildren = destinations.filter(d => d.parentDestinationId === JAPAN_ID);

    // All Japan destination IDs (country + all cities/regions)
    const allJapanIds = [JAPAN_ID, ...japanChildren.map(d => d.destinationId)];

    return res.status(200).json({
      japan_id: JAPAN_ID,
      total_japan_destinations: allJapanIds.length,
      all_japan_ids: allJapanIds,
      japan_cities: japanChildren.map(d => ({ id: d.destinationId, name: d.name, type: d.type })),
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
