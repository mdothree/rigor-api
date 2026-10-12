/**
 * /api/payment/webhook.js — Stripe -> Firestore subscription sync. ONE function
 * for two routes (Vercel Hobby allows 12 functions per deployment):
 *
 *  POST /api/payment/webhook            direct Stripe endpoint: the raw body is
 *                                       verified with STRIPE_WEBHOOK_SECRET.
 *  POST /api/payment/webhook-forwarded  MDO3D stripe-hub: body {eventId}. The body
 *                                       is NOT trusted; the event is re-fetched from
 *                                       Stripe with rigor's own key and handled only
 *                                       if it belongs to rigor (isRigorEvent).
 *
 * Event handling (idempotent per event) lives in ../lib/stripeEvents.js.
 * vercel.json routes the hub path here with ?src=hub.
 */
const { handleStripeEvent, isRigorEvent, stripe } = require("../lib/stripeEvents");
const { withRateLimit } = require("../_middleware/limits");

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,250}$/;

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

function isHubRequest(req) {
  if (req.query && req.query.src === "hub") return true;
  return /\/api\/payment\/webhook-forwarded(\?|$)/.test(String(req.url || ""));
}

async function direct(req, res) {
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
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
}

const forwarded = withRateLimit(async (req, res) => {
  let body = req.body;
  if (!body || typeof body !== "object" || Buffer.isBuffer(body)) {
    try { body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}"); } catch { body = {}; }
  }
  const eventId = body && body.eventId;
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
  if (!isRigorEvent(event)) return res.status(200).json({ received: true, ignored: true });
  try {
    await handleStripeEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Forwarded webhook handler error:", err);
    res.status(500).json({ error: "Webhook handling failed" });
  }
}, { name: "webhook-forwarded", windows: [{ windowMs: 60 * 1000, max: 120 }] });

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  return isHubRequest(req) ? forwarded(req, res) : direct(req, res);
};
