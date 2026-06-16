// Roam Trips — Viator Tour Fetcher (runs on Vercel, server-side)
// ──────────────────────────────────────────────────────────────────
// Receives a Viator URL, extracts the product code, fetches tour data
// from Viator sandbox API, and returns formatted text for the vetting artifact.
//
// VIATOR_API_KEY is set in Vercel environment variables — never exposed in browser.

const VIATOR_API_BASE = "https://api.sandbox.viator.com/partner";

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth check
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

  // Extract product code from Viator URL
  // Viator URLs look like: /tours/Tokyo/Tour-Name/d334-12345P1
  // Product code is the last segment after the last dash group e.g. 12345P1
  const productCodeMatch = url.match(/\/d\d+-([A-Z0-9]+)/i);
  if (!productCodeMatch) {
    return res.status(400).json({ error: "Could not extract product code from URL. Make sure it's a valid Viator tour URL." });
  }

  const productCode = productCodeMatch[1].toUpperCase();

  try {
    // Fetch product details
    const productRes = await fetch(`${VIATOR_API_BASE}/products/${productCode}`, {
      method: "GET",
      headers: {
        "exp-api-key": apiKey,
        "Accept": "application/json;version=2.0",
        "Accept-Language": "en-US",
      },
    });

    if (!productRes.ok) {
      const err = await productRes.json().catch(() => ({}));
      return res.status(productRes.status).json({
        error: `Viator API error: ${err?.message || productRes.statusText}`,
      });
    }

    const product = await productRes.json();

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
        const prices = avail?.bookableItems?.[0]?.seasons?.[0]?.pricingRecords?.[0]?.tieredPricing;
        if (prices?.length) {
          const minPrice = Math.min(...prices.map((p) => p.price?.original?.recommendedRetailPrice || Infinity));
          if (minPrice !== Infinity) priceInfo = `From USD ${minPrice}`;
        }
      }
    } catch (_) {
      // Price fetch failed silently — not critical
    }

    // Pull key fields from product response
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

    // Format text for pasting into vetting artifact
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
