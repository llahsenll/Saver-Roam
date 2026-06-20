// /api/debug-reviews.js
// Dumps the raw `reviews` object for a specific product so we can see the
// actual field names Viator uses, instead of assuming combinedAverageRating /
// totalReviews are correct (same class of bug as the pricingSummary issue).
//
// Usage: /api/debug-reviews?productCode=XXXXXXPX
// (use a product code you KNOW has visible TripAdvisor reviews)

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const productCode = req.query.productCode;

    if (!productCode) {
      return res.status(200).json({
        error: 'Pass a product code you know has reviews, e.g. ?productCode=423911P10',
      });
    }

    const response = await fetch(`${VIATOR_BASE}/products/${productCode}`, {
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
      has_reviews_field: !!data?.reviews,
      reviews_top_level_keys: data?.reviews ? Object.keys(data.reviews) : [],
      reviews_raw: data?.reviews || null,
      // what our current code is actually reading right now:
      what_current_code_reads: {
        rating: data?.reviews?.combinedAverageRating ?? 'undefined',
        review_count: data?.reviews?.totalReviews ?? 'undefined',
      },
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
