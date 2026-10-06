/**
 * /api/payment/webhook-forwarded.js
 * Receives events forwarded by the MDO3D stripe-hub (projects/mdo3d/stripe-hub):
 * POST {eventId, account, type} with header X-Stripe-Hub: 1.
 *
 * The body is NOT trusted. The event is re-fetched from Stripe with rigor's own
 * STRIPE_SECRET_KEY (so it must be the same Stripe account the hub received it
 * on), checked to belong to rigor, then handled by the same code as the direct
 * webhook (../lib/stripeEvents.js), which is idempotent per event.
 */
const { handleStripeEvent, isRigorEvent, stripe } = require("../lib/stripeEvents");
const { withRateLimit } = require("../_middleware/limits");

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,250}$/;

module.exports = withRateLimit(async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const eventId = req.body && req.body.eventId;
  if (typeof eventId !== "string" || !EVENT_ID_RE.test(eventId)) {
    return res.status(400).json({ error: "eventId is required" });
  }

  let event;
  try {
    event = await stripe.events.retrieve(eventId);
  } catch (err) {
    // Unknown id (wrong account / forged) is final; anything else lets the hub retry.
    const status = err.statusCode === 404 || err.statusCode === 400 ? 404 : 502;
    console.error("Forwarded webhook retrieve error:", err.message);
    return res.status(status).json({ error: "Could not retrieve event" });
  }

  if (!isRigorEvent(event)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    await handleStripeEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Forwarded webhook handler error:", err);
    res.status(500).json({ error: "Webhook handling failed" });
  }
}, { name: "webhook-forwarded", windows: [{ windowMs: 60 * 1000, max: 120 }] });
