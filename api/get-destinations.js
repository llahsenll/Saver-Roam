// /api/get-destinations.js
// One-off test — fetches Japan destination IDs from Viator
// Delete this file after you have the IDs

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

    // Filter to Japan-related destinations only
    const japan = destinations.filter(d =>
      d.name?.toLowerCase().includes('japan') ||
      d.parentId === 'japan' ||
      JSON.stringify(d).toLowerCase().includes('japan') ||
      // Also grab by known country code
      d.type === 'COUNTRY' && d.name === 'Japan'
    );

    // Also grab anything under Japan (cities, regions)
    const japanCountry = destinations.find(d => d.name === 'Japan' && d.type === 'COUNTRY');
    const japanChildren = japanCountry
      ? destinations.filter(d => d.parentId === japanCountry.destinationId || d.parentId === String(japanCountry.destinationId))
      : [];

    return res.status(200).json({
      total_destinations: destinations.length,
      japan_country: japanCountry || null,
      japan_related: japan,
      japan_cities_regions: japanChildren,
      // Raw sample so we can see the data structure
      sample_raw: destinations.slice(0, 3),
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
