// Roam Trips — Viator Tour Fetcher (runs on Vercel, server-side)
// ──────────────────────────────────────────────────────────────────
// Receives a Viator URL, extracts the product code, fetches tour data
// from Viator production API, and returns formatted text for the vetting artifact.

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

  if (!url) {
    return res.status(400).json({ error: "No URL provided." });
  }

  const productCodeMatch = url.match(/\/d\d+-([A-Z0-9]+)/i);
  if (!productCodeMatch) {
    return res.status(400).json({ error: "Could not extract product code from URL. Make sure it's a valid Viator tour URL." });
  }

  const productCode = productCodeMatch[1].toUpperCase();
  console.log("DEBUG product code:", productCode);

  try {
    const productRes = await fetch(`${VIATOR_API_BASE}/products/${productCode}`, {
      method: "GET",
      headers: {
        "exp-api-key": apiKey,
        "Accept": "application/json;version=2.0",
        "Accept-Language": "en-US",
      },
    });

    const product = await productRes.json();

    // LOG FULL RESPONSE so we can see exact field structure
    console.log("DEBUG full product response:", JSON.stringify(product, null, 2));

    if (!productRes.ok) {
      return res.status(productRes.status).json({
        error: `Viator API error: ${product?.message || productRes.statusText}`,
      });
    }

    // Fetch availability/pricing
    let priceInfo = "Not available";
    try {
      const availRes = await fetch(
        `${VIATOR_API_BASE}/availability/schedules/${productCode}`,
        {
          method: "GET",
          headers: {
            "exp-api-key": apiKey,
            "Accept": "application/json;version=2.0",
            "Accept-Language": "en-US",
          },
        }
      );
      if (availRes.ok) {
        const avail = await availRes.json();
        console.log("DEBUG avail response:", JSON.stringify(avail, null, 2));
        const prices = avail?.bookableItems?.[0]?.seasons?.[0]?.pricingRecords?.[0]?.tieredPricing;
        if (prices?.length) {
          const minPrice = Math.min(...prices.map((p) => p.price?.original?.recommendedRetailPrice || Infinity));
          if (minPrice !== Infinity) priceInfo = `From USD ${minPrice}`;
        }
      }
    } catch (_) {}

    const name = product?.title || "Unknown";
    const description = product?.description || "No description available";
    const duration = product?.itinerary?.duration?.fixedDurationInMinutes
      ? `${Math.round(product.itinerary.duration.fixedDurationInMinutes / 60)} hours`
      : product?.duration?.label || "Not specified";
    const rating = product?.reviews?.combinedAverageRating || "No rating";
    const reviewCount = product?.reviews?.totalReviews || 0;
    const maxGroupSize = product?.groupSize?.maxGroupSize || "Not specified";
    const inclusions = product?.inclusions?.map((i) => `- ${i.otherDescription || i.typeDescription}`).join("\n") || "Not listed";
    const exclusions = product?.exclusions?.map((e) => `- ${e.otherDescription || e.typeDescription}`).join("\n") || "Not listed";
    const cancellationPolicy = product?.cancellationPolicy?.description || "Not specified";
    const highlights = product?.additionalInfo?.map((a) => `- ${a.description}`).join("\n") || "Not listed";
    const imageUrl = product?.images?.[0]?.variants?.find((v) => v.width >= 600)?.url || product?.images?.[0]?.variants?.[0]?.url || "";
    const supplier = product?.supplier?.name || "Not specified";
    const language = product?.languageGuides?.[0]?.language || "English";

    const formattedText = `TOUR NAME: ${name}

SOURCE: Viator
PRODUCT CODE: ${productCode}

RATING: ${rating} (${reviewCount} reviews)
PRICE: ${priceInfo}
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
      formattedText,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
