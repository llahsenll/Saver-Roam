// DEBUG — test exchange rates with POST no body
const VIATOR_API_BASE = "https://api.viator.com/partner";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = req.headers["x-roam-token"];
  if (!token || token !== process.env.ROAM_SAVE_TOKEN) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.VIATOR_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "VIATOR_API_KEY not set" });

  // Try 1: no body
  const r1 = await fetch(`${VIATOR_API_BASE}/exchange-rates`, {
    method: "POST",
    headers: {
      "exp-api-key": apiKey,
      "Accept": "application/json;version=2.0",
      "Content-Type": "application/json",
    },
  });
  const d1 = await r1.json();
  console.log("Try 1 (no body):", JSON.stringify(d1, null, 2));

  // Try 2: different body format
  const r2 = await fetch(`${VIATOR_API_BASE}/exchange-rates`, {
    method: "POST",
    headers: {
      "exp-api-key": apiKey,
      "Accept": "application/json;version=2.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targetCurrency: "USD" }),
  });
  const d2 = await r2.json();
  console.log("Try 2 (targetCurrency only):", JSON.stringify(d2, null, 2));

  return res.status(200).json({ debug: true, try1: d1, try2: d2 });
}
