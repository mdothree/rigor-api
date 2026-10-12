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
 *  - priceId must be one of STRIPE_PRO_PRICE_IDS / STRIPE_TEAM_PRICE_IDS; with
 *    neither set, checkout is refused (503) instead of selling any account price.
 *  - Q7: priceId may be the alias "pro" / "team" (= the first configured id), so
 *    the static frontends never hard-code a price id; the response carries the
 *    publishable key (STRIPE_PUBLISHABLE_KEY) from the same env as the secret key.
 *  - Q7: client_reference_id "rigor:<uid>" (stripe-hub routing convention) and the
 *    account email are set; an account that already has an active plan is refused
 *    (409) so nobody pays twice. return_url = <tool>/success?session_id=…, where the
 *    page calls /api/payment/confirm to show access.
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require("../_middleware/auth");
const { withCors, ALLOWED_ORIGINS } = require("../_middleware/cors");
const { withRateLimit } = require("../_middleware/limits");
const admin = require("../lib/firebase");
const { isPaidSubscription } = require("../lib/quota");

function allowedPriceIds() {
  return [process.env.STRIPE_PRO_PRICE_IDS, process.env.STRIPE_TEAM_PRICE_IDS]
    .join(",").split(",").map(s => s.trim()).filter(Boolean);
}

function configured(name) {
  return (process.env[name] || "").split(",").map(s => s.trim()).filter(Boolean);
}

// "pro" / "team" -> the first configured price id for that plan.
function resolvePriceAlias(priceId) {
  if (priceId === "pro") return configured("STRIPE_PRO_PRICE_IDS")[0] || null;
  if (priceId === "team") return configured("STRIPE_TEAM_PRICE_IDS")[0] || null;
  return priceId;
}

function returnOrigin(origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // vercel dev
  return null;
}

module.exports = withCors(requireAuth(withRateLimit(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const requested = (req.body || {}).priceId;
    const userId = req.user.uid; // verified token, not the body
    if (!requested || typeof requested !== "string") return res.status(400).json({ error: "Missing priceId" });
    const priceId = resolvePriceAlias(requested);

    // Fail closed: the MDO3 Stripe account sells other recurring products, and only
    // configured rigor prices may be bought here (the webhook grants nothing else).
    const allowed = allowedPriceIds();
    if (!allowed.length) return res.status(503).json({ error: "Checkout is not configured yet" });
    if (!priceId || !allowed.includes(priceId)) {
      return res.status(400).json({ error: "Unknown priceId" });
    }

    const origin = returnOrigin(req.headers.origin);
    if (!origin) return res.status(400).json({ error: "Unknown origin" });

    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
    if (!publishableKey) return res.status(503).json({ error: "Checkout is not configured yet" });

    const existing = await admin.firestore().collection("subscriptions").doc(userId).get();
    if (existing.exists && isPaidSubscription(existing.data())) {
      return res.status(409).json({ error: "This account already has an active Rigor plan. Use Manage Plan to change it.", code: "already_subscribed" });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      client_reference_id: `rigor:${userId}`,
      ...(req.user.email ? { customer_email: req.user.email } : {}),
      metadata: { userId, serviceName: "rigor" },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      subscription_data: {
        metadata: { userId, serviceName: "rigor" }
      }
    });

    res.status(200).json({ clientSecret: session.client_secret, publishableKey });
  } catch (err) {
    console.error("create-embedded-session error:", err);
    res.status(500).json({ error: err.message });
  }
}, { name: "create-embedded-session", windows: [{ windowMs: 60 * 1000, max: 10 }] })));
