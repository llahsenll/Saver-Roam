// Roam Trips — Airtable Save Function (runs on Vercel, server-side)
// ──────────────────────────────────────────────────────────────────
// This receives a scored tour from the form and writes it to Airtable.
// Because it runs on the server, there is NO CORS and NO Claude API call.
//
// The Airtable key is read from an environment variable (AIRTABLE_API_KEY)
// that you set in the Vercel dashboard — it is never exposed in the browser.

const AIRTABLE_BASE_ID = "app76496ZD5m3TX8M";
const AIRTABLE_TABLE_ID = "tblc3XA7l1jH6RN1F";

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "AIRTABLE_API_KEY is not set in Vercel environment variables." });
  }

  // req.body is already parsed JSON on Vercel
  const d = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  // Build Airtable fields. Only include values that exist.
  const fields = {};
  const setText = (key, val) => { if (val !== undefined && val !== null && val !== "") fields[key] = String(val); };
  const setNum  = (key, val) => { if (val !== undefined && val !== null && val !== "" && !isNaN(Number(val))) fields[key] = Number(val); };

  setText("Name", d.name);
  setText("City", d.city);
  setText("Category", d.category);
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

  try {
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
      return res.status(airtableRes.status).json({ error: data?.error?.message || JSON.stringify(data) });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
