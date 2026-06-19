// /api/debug-tour.js
// Fetches one page from Viator and dumps the full raw first product
// Delete this file after debugging

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const response = await fetch(`${VIATOR_BASE}/products/modified-since?count=5`, {
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
    const products = data.products || [];

    // Dump the full raw first product so we can see every field
    return res.status(200).json({
      total_returned: products.length,
      first_product_full: products[0] || null,
      first_product_keys: products[0] ? Object.keys(products[0]) : [],
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
