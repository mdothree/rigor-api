/**
 * /api/payment/webhook.js
 * Stripe webhook — updates Firebase Firestore on subscription events
 * Raw body required: set bodyParser: false in vercel.json for this route
 * Event handling lives in ../lib/stripeEvents.js (shared with webhook-forwarded.js).
 */
const { handleStripeEvent, stripe } = require("../lib/stripeEvents");

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    await handleStripeEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: err.message });
  }
};
