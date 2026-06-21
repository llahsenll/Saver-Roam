// Roam Trips — Airtable Save Function (runs on Vercel, server-side)
// ──────────────────────────────────────────────────────────────────
// This receives a scored tour from the form and writes it to Airtable.
// Because it runs on the server, there is NO CORS and NO Claude API call.
//
// The Airtable key is read from an environment variable (AIRTABLE_API_KEY)
// that you set in the Vercel dashboard — it is never exposed in the browser.

const AIRTABLE_BASE_ID = "app76496ZD5m3TX8M";
const AIRTABLE_TABLE_ID = "tblc3XA7l1jH6RN1F";

async function saveOneRecord(d, apiKey) {
  // Build Airtable fields. Only include values that exist.
  const fields = {};
  const setText = (key, val) => { if (val !== undefined && val !== null && val !== "") fields[key] = String(val); };
  const setNum  = (key, val) => { if (val !== undefined && val !== null && val !== "" && !isNaN(Number(val))) fields[key] = Number(val); };

  setText("Name", d.name);
  setText("City", d.city);
  setText("Category", d.category);
  setText("Secondary Category", d.secondary_category);
  setText("Price Tier", d.price_tier);
  setText("Duration", d.duration);
  setText("Group Type", d.group_type);
  setText("Language", d.language);
  setNum("Price", d.price);
  setNum("Max Group Size", d.max_group_size);
  setNum("Roam Score", d.roam_score);
  setNum("Reputation Score", d.reputation_score);
  setNum("Safety Score", d.safety_score);
  setNum("Transparency Score", d.transparency_score);
  setNum("Value Score", d.value_score);
  setText("AI Summary", d.ai_summary);
  setText("Full Description", d.full_description);
  setText("Highlights", d.highlights);
  setText("Status", d.status || "Approved");
  setText("Source", d.source);
  setText("Affiliate URL", d.affiliate_url);
  setText("Product Code", d.product_code);
  if (d.image_url) fields["Image"] = d.image_url;

  const airtableRes = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }
  );

  const data = await airtableRes.json();

  if (!airtableRes.ok) {
    return { success: false, product_code: d.product_code, error: data?.error?.message || JSON.stringify(data) };
  }
  return { success: true, product_code: d.product_code, id: data.id };
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth check — request must include the correct secret token
  const token = req.headers["x-roam-token"];
  if (!token || token !== process.env.ROAM_SAVE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "AIRTABLE_API_KEY is not set in Vercel environment variables." });
  }

  // req.body is already parsed JSON on Vercel
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  // Accept either a single record (object) or a batch (array) — same
  // shape per record either way. Single-record callers see no change
  // in behavior at all.
  const isBatch = Array.isArray(body);
  const records = isBatch ? body : [body];

  if (records.length === 0) {
    return res.status(400).json({ error: "No records provided." });
  }

  try {
    // Airtable's own rate limit is ~5 requests/second per base, so batches
    // are written sequentially with a small delay rather than all at once.
    const results = [];
    for (const record of records) {
      results.push(await saveOneRecord(record, apiKey));
      if (records.length > 1) await new Promise(r => setTimeout(r, 250));
    }

    if (!isBatch) {
      // Preserve the original single-record response shape exactly.
      const single = results[0];
      if (!single.success) return res.status(500).json({ error: single.error });
      return res.status(200).json({ success: true, id: single.id });
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.length - succeeded;
    return res.status(200).json({
      success: failed === 0,
      saved: succeeded,
      failed: failed,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
