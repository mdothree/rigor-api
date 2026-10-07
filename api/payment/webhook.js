/**
 * /api/payment/webhook.js
 * Stripe webhook — updates Firebase Firestore on subscription events
 * Reads the raw request stream for Stripe signature verification (do not touch req.body first).
 * Event handling lives in ../lib/stripeEvents.js (shared with webhook-forwarded.js).
 */
const { handleStripeEvent, stripe } = require("../lib/stripeEvents");

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Collect the unparsed body; @vercel/node only parses req.body lazily when it is read.
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.rawBody !== "undefined") return Promise.resolve(Buffer.from(req.rawBody));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
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
