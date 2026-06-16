// DEBUG — test exchange rates with POST
const VIATOR_API_BASE = "https://api.viator.com/partner";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = req.headers["x-roam-token"];
  if (!token || token !== process.env.ROAM_SAVE_TOKEN) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.VIATOR_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "VIATOR_API_KEY not set" });

  const ratesRes = await fetch(`${VIATOR_API_BASE}/exchange-rates`, {
    method: "POST",
    headers: {
      "exp-api-key": apiKey,
      "Accept": "application/json;version=2.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourceCurrencies: ["JPY"], targetCurrency: "USD" }),
  });

  const rates = await ratesRes.json();
  console.log("DEBUG exchange rates status:", ratesRes.status);
  console.log("DEBUG exchange rates response:", JSON.stringify(rates, null, 2));

  return res.status(200).json({ debug: true, ratesStatus: ratesRes.status, rates });
}
