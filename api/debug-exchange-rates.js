// /api/debug-exchange-rates.js
// Dumps the raw /exchange-rates response so we can see exactly what Viator
// returns for JPY -> USD, and check it against what ingest-availability.js
// is actually computing.

const VIATOR_BASE = 'https://api.viator.com/partner';
const VIATOR_KEY = process.env.VIATOR_API_KEY;

export default async function handler(req, res) {
  try {
    const response = await fetch(`${VIATOR_BASE}/exchange-rates`, {
      method: 'POST',
      headers: {
        'exp-api-key': VIATOR_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetCurrency: 'USD' }),
    });

    const bodyText = await response.text();
    const data = bodyText ? JSON.parse(bodyText) : null;

    const jpyEntries = (data?.rates || []).filter(r => r.sourceCurrency === 'JPY');

    // Show what our actual conversion math would produce for the test tour
    const testJpyAmount = 135000;
    const sampleConversion = jpyEntries.map(e => ({
      rate_used: e.rate,
      result_for_135000_jpy: Math.round(testJpyAmount * e.rate * 100) / 100,
    }));

    return res.status(200).json({
      http_status: response.status,
      top_level_keys: data ? Object.keys(data) : [],
      total_rate_entries: data?.rates?.length || 0,
      jpy_entries_found: jpyEntries.length,
      jpy_entries: jpyEntries,
      sample_conversion_check: sampleConversion,
      full_raw_response: data,
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
