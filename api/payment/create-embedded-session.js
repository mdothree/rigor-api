/**
 * /api/payment/create-embedded-session.js
 * Creates a Stripe Embedded Checkout client_secret
 * Uses stripe.checkout.sessions.create with ui_mode: 'embedded'
 *
 * Security:
 *  - userId comes from the verified Firebase ID token (requireAuth), never the
 *    request body; the webhook grants the plan to metadata.userId.
 *  - CORS uses the shared explicit allowlist (withCors) instead of reflecting any
 *    Origin, and answers the preflight before requireAuth.
 *  - priceId must be one of the configured paid prices when STRIPE_PRO_PRICE_IDS /
 *    STRIPE_TEAM_PRICE_IDS are set (the webhook maps any unknown price to "pro").
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require("../_middleware/auth");
const { withCors, ALLOWED_ORIGINS } = require("../_middleware/cors");
const { withRateLimit } = require("../_middleware/limits");

function allowedPriceIds() {
  return [process.env.STRIPE_PRO_PRICE_IDS, process.env.STRIPE_TEAM_PRICE_IDS]
    .join(",").split(",").map(s => s.trim()).filter(Boolean);
}

function returnOrigin(origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // vercel dev
  return null;
}

module.exports = withCors(requireAuth(withRateLimit(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { priceId } = req.body || {};
    const userId = req.user.uid; // verified token, not the body
    if (!priceId || typeof priceId !== "string") return res.status(400).json({ error: "Missing priceId" });

    const allowed = allowedPriceIds();
    if (allowed.length && !allowed.includes(priceId)) {
      return res.status(400).json({ error: "Unknown priceId" });
    }

    const origin = returnOrigin(req.headers.origin);
    if (!origin) return res.status(400).json({ error: "Unknown origin" });

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      metadata: { userId },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      subscription_data: {
        metadata: { userId }
      }
    });

    res.status(200).json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error("create-embedded-session error:", err);
    res.status(500).json({ error: err.message });
  }
}, { name: "create-embedded-session", windows: [{ windowMs: 60 * 1000, max: 10 }] })));
