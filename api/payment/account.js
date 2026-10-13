/**
 * /api/payment/account.js — ONE function for three routes (Vercel Hobby: 12
 * functions per deployment). vercel.json passes ?op=.
 *
 *  GET  /health, /api/health            op=health  (no auth)
 *       200 {ok:true} only when every required env var is present and Firebase
 *       Admin initializes; 503 {ok:false, checks} otherwise. Values are never
 *       returned, only booleans. ?deep=1 also reads Firestore.
 *  POST /api/payment/portal             op=portal  (auth) Stripe billing portal
 *  POST /api/payment/confirm            op=confirm (auth) Q7 success page:
 *       {sessionId?} -> {plan, status, active}. With a sessionId the completed
 *       Checkout Session is read from Stripe and, if it is a paid rigor
 *       subscription that belongs to this account (metadata.userId /
 *       client_reference_id) or to nobody yet (a Payment Link payment), Pro is
 *       granted to the caller right away; the webhook does the same later
 *       (idempotent). A session that belongs to another account is 403.
 *
 * Firebase/Stripe modules are required lazily so /health can report missing
 * configuration instead of crashing at cold start.
 */
const { requireAuth } = require("../_middleware/auth");
const { withCors, ALLOWED_ORIGINS } = require("../_middleware/cors");
const { withRateLimit } = require("../_middleware/limits");

const REQUIRED_ENV = {
  firebase: ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"],
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"],
  webhook: ["STRIPE_WEBHOOK_SECRET"],
  prices: ["STRIPE_PRO_PRICE_IDS"],
  model: ["ANTHROPIC_API_KEY"]
};
const SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;

function op(req) {
  if (req.query && req.query.op) return String(req.query.op);
  const path = String(req.url || "").split("?")[0];
  if (/\/health$/.test(path)) return "health";
  if (/\/confirm$/.test(path)) return "confirm";
  if (/\/portal$/.test(path)) return "portal";
  return "";
}

// ─── health ───────────────────────────────────────────────────────────────────
async function health(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // L-RES-03: the tool pages read this cross-origin (apiReachable() in public/js/config/env.js)
  // before checkout opens, so allow-listed rigor.design origins get CORS on GET. Booleans only.
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Method not allowed" });
  const checks = {};
  for (const [k, names] of Object.entries(REQUIRED_ENV)) checks[k] = names.every(n => !!process.env[n]);
  // Live-mode keys must be used together (a test secret with a live publishable key cannot check out).
  const sk = process.env.STRIPE_SECRET_KEY || "", pk = process.env.STRIPE_PUBLISHABLE_KEY || "";
  checks.stripeModeMatch = !!sk && !!pk && (/^(sk|rk)_live_/.test(sk) === /^pk_live_/.test(pk));
  try {
    const admin = require("../lib/firebase");
    if (req.query && req.query.deep === "1") await admin.firestore().collection("subscriptions").doc("__health__").get();
    checks.firebaseInit = true;
  } catch {
    checks.firebaseInit = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return res.status(ok ? 200 : 503).json({ ok, service: "rigor-api", checks });
}

// ─── portal ───────────────────────────────────────────────────────────────────
async function portal(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const admin = require("../lib/firebase");
    const { stripe } = require("../lib/stripeEvents");
    const subSnap = await admin.firestore().collection("subscriptions").doc(req.user.uid).get();
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
}

// ─── confirm ──────────────────────────────────────────────────────────────────
function view(d) {
  const { isPaidSubscription } = require("../lib/quota");
  if (!d) return { plan: "none", status: "none", active: false };
  return { plan: d.plan || "none", status: d.status || "none", active: isPaidSubscription(d), currentPeriodEnd: d.currentPeriodEnd || null };
}

async function confirm(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const uid = req.user.uid;
  const admin = require("../lib/firebase");
  const ev = require("../lib/stripeEvents");
  const db = admin.firestore();
  const sessionId = (req.body && req.body.sessionId) || null;

  try {
    if (sessionId !== null) {
      if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return res.status(400).json({ error: "Invalid sessionId" });
      let session;
      try {
        session = await ev.stripe.checkout.sessions.retrieve(sessionId);
      } catch (err) {
        return res.status(err.statusCode === 404 ? 404 : 502).json({ error: "Checkout session not found" });
      }
      if (session.mode !== "subscription" || !session.subscription) return res.status(400).json({ error: "Not a subscription checkout" });
      if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status)) {
        return res.status(202).json({ pending: true, ...view(null) });
      }
      const owner = (session.metadata?.userId && session.metadata.userId !== "anonymous")
        ? session.metadata.userId : ev.uidFromReference(session.client_reference_id);
      if (owner && owner !== uid) return res.status(403).json({ error: "This payment belongs to a different Rigor account." });

      const subscription = await ev.stripe.subscriptions.retrieve(session.subscription);
      const plan = ev.resolvePlan(subscription.items?.data?.[0]?.price?.id);
      if (!plan) return res.status(400).json({ error: "Not a Rigor plan" });

      // An unreferenced (Payment Link) payment can be claimed by exactly one account.
      if (!owner) {
        const taken = await db.collection("subscriptions")
          .where("stripeSubscriptionId", "==", subscription.id).limit(1).get();
        if (!taken.empty && taken.docs[0].id !== uid) {
          return res.status(403).json({ error: "This payment is already linked to a different Rigor account." });
        }
      }
      // created 0 = write the current Stripe truth without moving event ordering.
      await ev.grantFromSubscription(uid, { id: `confirm_${sessionId}`, created: 0 }, session, subscription, plan);
    }
    const snap = await db.collection("subscriptions").doc(uid).get();
    return res.status(200).json(view(snap.exists ? snap.data() : null));
  } catch (err) {
    console.error("confirm error:", err);
    return res.status(500).json({ error: "Could not confirm the subscription right now. Please retry in a moment." });
  }
}

const authed = {
  portal: withCors(requireAuth(withRateLimit(portal, { name: "portal", windows: [{ windowMs: 60 * 1000, max: 10 }] }))),
  confirm: withCors(requireAuth(withRateLimit(confirm, { name: "confirm", windows: [{ windowMs: 60 * 1000, max: 20 }] })))
};

module.exports = async (req, res) => {
  const o = op(req);
  if (o === "health") return health(req, res);
  if (authed[o]) return authed[o](req, res);
  return res.status(404).json({ error: "Not found" });
};
