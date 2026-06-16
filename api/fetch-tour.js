// Roam Trips — Viator Tour Fetcher (runs on Vercel, server-side)
const VIATOR_API_BASE = "https://api.viator.com/partner";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = req.headers["x-roam-token"];
  if (!token || token !== process.env.ROAM_SAVE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.VIATOR_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "VIATOR_API_KEY is not set in Vercel environment variables." });
  }

  const { url } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!url) return res.status(400).json({ error: "No URL provided." });

  const productCodeMatch = url.match(/\/d\d+-([A-Z0-9]+)/i);
  if (!productCodeMatch) {
    return res.status(400).json({ error: "Could not extract product code from URL. Make sure it's a valid Viator tour URL." });
  }

  const productCode = productCodeMatch[1].toUpperCase();

  try {
    // Fetch all three in parallel — product, availability, exchange rates
    const [productRes, availRes, ratesRes] = await Promise.all([
      fetch(`${VIATOR_API_BASE}/products/${productCode}`, {
        method: "GET",
        headers: {
          "exp-api-key": apiKey,
          "Accept": "application/json;version=2.0",
          "Accept-Language": "en-US",
        },
      }),
      fetch(`${VIATOR_API_BASE}/availability/schedules/${productCode}`, {
        method: "GET",
        headers: {
          "exp-api-key": apiKey,
          "Accept": "application/json;version=2.0",
          "Accept-Language": "en-US",
        },
      }),
      fetch(`${VIATOR_API_BASE}/exchange-rates`, {
        method: "GET",
        headers: {
          "exp-api-key": apiKey,
          "Accept": "application/json;version=2.0",
        },
      }),
    ]);

    const product = await productRes.json();

    if (!productRes.ok) {
      return res.status(productRes.status).json({
        error: `Viator API error: ${product?.message || productRes.statusText}`,
      });
    }

    // Parse exchange rates — get JPY to USD rate
    let jpyToUsd = null;
    try {
      if (ratesRes.ok) {
        const rates = await ratesRes.json();
        // Response is array of { sourceCurrency, targetCurrency, rate }
        const jpyRate = rates?.find?.(r => r.sourceCurrency === "JPY" && r.targetCurrency === "USD")
          || rates?.exchangeRates?.find?.(r => r.sourceCurrency === "JPY" && r.targetCurrency === "USD");
        if (jpyRate?.rate) jpyToUsd = jpyRate.rate;
      }
    } catch (_) {}

    // Parse availability
    let priceJPY = null;
    let priceUSD = null;
    let priceDisplay = "Not available";
    let maxGroupSize = "Not specified";
    let currency = "JPY";

    try {
      if (availRes.ok) {
        const avail = await availRes.json();
        currency = avail?.currency || "JPY";

        if (avail?.summary?.fromPrice) {
          priceJPY = avail.summary.fromPrice;
          if (jpyToUsd && currency === "JPY") {
            priceUSD = Math.ceil(priceJPY * jpyToUsd);
            priceDisplay = `From $${priceUSD.toLocaleString()} USD`;
          } else {
            priceDisplay = `From ${currency} ${priceJPY.toLocaleString()}`;
          }
        }

        // Max group size from pricing tiers
        let maxTravelers = 0;
        for (const item of avail?.bookableItems || []) {
          const records = item?.seasons?.[0]?.pricingRecords?.[0]?.pricingDetails || [];
          for (const record of records) {
            if (record.ageBand === "ADULT" && record.maxTravelers > maxTravelers) {
              maxTravelers = record.maxTravelers;
            }
          }
        }
        if (maxTravelers > 0) maxGroupSize = String(maxTravelers);
      }
    } catch (_) {}

    // Product fields
    const name = product?.title || "Unknown";
    const description = product?.description || "No description available";

    // Duration — try multiple fields
    let duration = "Not specified";
    if (product?.itinerary?.duration?.fixedDurationInMinutes) {
      const mins = product.itinerary.duration.fixedDurationInMinutes;
      duration = mins >= 60 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    } else if (product?.itinerary?.duration?.variableDurationFromMinutes) {
      const from = Math.round(product.itinerary.duration.variableDurationFromMinutes / 60);
      const to = Math.round((product.itinerary.duration.variableDurationToMinutes || product.itinerary.duration.variableDurationFromMinutes) / 60);
      duration = from === to ? `${from} hours` : `${from}–${to} hours`;
    } else if (product?.duration?.label) {
      duration = product.duration.label;
    }

    const rating = product?.reviews?.combinedAverageRating || "No rating";
    const reviewCount = product?.reviews?.totalReviews || 0;
    const inclusions = product?.inclusions?.map((i) => `- ${i.otherDescription || i.typeDescription}`).join("\n") || "Not listed";
    const exclusions = product?.exclusions?.map((e) => `- ${e.otherDescription || e.typeDescription}`).join("\n") || "Not listed";
    const cancellationPolicy = product?.cancellationPolicy?.description || "Not specified";
    const highlights = product?.additionalInfo?.map((a) => `- ${a.description}`).join("\n") || "Not listed";
    const imageUrl = product?.images?.[0]?.variants?.find((v) => v.width >= 600)?.url || product?.images?.[0]?.variants?.[0]?.url || "";
    const supplier = product?.supplier?.name || "Not specified";
    const language = product?.languageGuides?.[0]?.language || "English";
    const pricingType = product?.pricingInfo?.type || "PER_PERSON";

    const formattedText = `TOUR NAME: ${name}

SOURCE: Viator
PRODUCT CODE: ${productCode}

RATING: ${rating} (${reviewCount} reviews)
PRICE: ${priceDisplay} (${pricingType})
DURATION: ${duration}
MAX GROUP SIZE: ${maxGroupSize}
LANGUAGE: ${language}
SUPPLIER: ${supplier}

DESCRIPTION:
${description}

HIGHLIGHTS:
${highlights}

INCLUSIONS:
${inclusions}

EXCLUSIONS:
${exclusions}

CANCELLATION POLICY:
${cancellationPolicy}

IMAGE URL:
${imageUrl}`;

    return res.status(200).json({
      success: true,
      productCode,
      name,
      imageUrl,
      language,
      priceUSD,
      priceJPY,
      formattedText,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
