// /api/debug-tour.js
// Tests a single Viator API call with full error details

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const url = `${VIATOR_BASE}/products/modified-since?count=10`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'exp-api-key': VIATOR_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
      },
      signal: AbortSignal.timeout(30000),
    });

    const rawText = await response.text();
    
    return res.status(200).json({
      status: response.status,
      ok: response.ok,
      raw_length: rawText.length,
      raw_preview: rawText.substring(0, 500),
    });

  } catch (error) {
    return res.status(500).json({ 
      error: error.message,
      type: error.constructor.name,
    });
  }
}
