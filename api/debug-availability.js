// /api/debug-availability.js
// Checks what the /availability/schedules/{productCode} response actually looks like
// for one of our saved active Japan tours, so we know exactly where price lives
// before writing real ingestion logic.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  try {
    // Allow overriding via ?productCode=XXXX, otherwise grab one from Supabase
    let productCode = req.query.productCode;

    if (!productCode) {
      const sbRes = await fetch(`${SUPABASE_URL}/tours_raw?select=product_code&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      });
      const sbText = await sbRes.text();
      const rows = sbText ? JSON.parse(sbText) : [];
      productCode = rows[0]?.product_code;
    }

    if (!productCode) {
      return res.status(200).json({ error: 'No saved tours found and no productCode param given' });
    }

    const response = await fetch(`${VIATOR_BASE}/availability/schedules/${productCode}`, {
      method: 'GET',
      headers: {
        'exp-api-key': VIATOR_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
      },
    });

    const bodyText = await response.text();
    const data = bodyText ? JSON.parse(bodyText) : null;

    return res.status(200).json({
      product_code: productCode,
      http_status: response.status,
      top_level_keys: data ? Object.keys(data) : [],
      raw_response: data,
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
