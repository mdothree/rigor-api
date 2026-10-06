/**
 * /api/payment/portal.js
 * Opens Stripe Customer Portal for subscription management
 * The uid comes from the verified Firebase ID token. It previously came from the
 * request body, so anyone who knew a uid could open that user's billing portal.
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("../lib/firebase");
const { requireAuth } = require("../_middleware/auth");
const { withCors, ALLOWED_ORIGINS } = require("../_middleware/cors");
const { withRateLimit } = require("../_middleware/limits");

module.exports = withCors(requireAuth(withRateLimit(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const userId = req.user.uid; // verified token, not the body

    const db = admin.firestore();
    const subSnap = await db.collection("subscriptions").doc(userId).get();
    if (!subSnap.exists) return res.status(404).json({ error: "No subscription found" });

    const { stripeCustomerId } = subSnap.data();
    if (!stripeCustomerId) return res.status(400).json({ error: "No Stripe customer linked" });

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: (ALLOWED_ORIGINS.has(req.headers.origin) ? req.headers.origin : "https://rigor.design") + "/"
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("portal error:", err);
    res.status(500).json({ error: err.message });
  }
}, { name: "portal", windows: [{ windowMs: 60 * 1000, max: 10 }] })));
