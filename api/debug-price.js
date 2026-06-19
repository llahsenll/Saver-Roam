// /api/debug-price.js
// Checks what pricing fields actually exist on an active Japan tour

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  try {
    // Get one saved product_code from Supabase
    const sbRes = await fetch(`${SUPABASE_URL}/tours_raw?select=product_code&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await sbRes.json();
    const productCode = rows[0]?.product_code;

    if (!productCode) {
      return res.status(200).json({ error: 'No saved tours found yet' });
    }

    // Fetch this exact product fresh from Viator to see all pricing fields
    const response = await fetch(`${VIATOR_BASE}/products/${productCode}`, {
      method: 'GET',
      headers: {
        'exp-api-key': VIATOR_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
      },
    });

    const data = await response.json();

    return res.status(200).json({
      product_code: productCode,
      has_pricingSummary: !!data.pricingSummary,
      pricingSummary: data.pricingSummary || null,
      has_pricingInfo: !!data.pricingInfo,
      pricingInfo: data.pricingInfo || null,
      top_level_keys: Object.keys(data),
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
