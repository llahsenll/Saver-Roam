// /api/debug-tour.js
// Finds first ACTIVE product and dumps its full structure
// Delete after debugging

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    let cursor = null;
    let pagesChecked = 0;
    const MAX_PAGES = 20;

    while (pagesChecked < MAX_PAGES) {
      const url = cursor
        ? `${VIATOR_BASE}/products/modified-since?count=100&cursor=${encodeURIComponent(cursor)}`
        : `${VIATOR_BASE}/products/modified-since?count=100`;

      const response = await fetch(url, {
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
      cursor = data.nextCursor || null;
      pagesChecked++;

      const active = products.filter(p => p.status === 'ACTIVE');
      const inactive = products.filter(p => p.status !== 'ACTIVE');

      if (active.length > 0) {
        return res.status(200).json({
          found_active_on_page: pagesChecked,
          active_count_this_page: active.length,
          inactive_count_this_page: inactive.length,
          first_active_product: active[0],
          first_active_keys: Object.keys(active[0]),
        });
      }

      if (!cursor) break;
    }

    return res.status(200).json({
      message: `No active products found in ${pagesChecked} pages`,
      pages_checked: pagesChecked,
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
