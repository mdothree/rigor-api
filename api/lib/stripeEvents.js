/**
 * lib/stripeEvents.js — Stripe event -> Firestore subscription sync.
 * Shared by /api/payment/webhook (direct, signature-verified) and
 * /api/payment/webhook-forwarded (stripe-hub; event re-fetched from Stripe).
 *
 * Idempotency: every write is a merge-set of the same values for the same event,
 * and payment_events rows are keyed by event id, so reprocessing an event is safe.
 * Ordering: Stripe does not guarantee delivery order, so subscription writes go
 * through writeSub(), which skips an event older than the last one applied
 * (lastEventCreated) — a late invoice.paid can't resurrect a canceled plan.
 * Payment Links (Q7): a checkout.session.completed without metadata.userId (the
 * rigor Stripe Payment Link) is matched by client_reference_id or a verified
 * email; otherwise it is parked in unclaimed_payments/{sessionId} and the payer
 * claims it on /success through POST /api/payment/confirm {sessionId}.
 * Unknown prices: resolvePlan() returns null for a price that is not in
 * STRIPE_PRO_PRICE_IDS / STRIPE_TEAM_PRICE_IDS and nothing is granted (the MDO3
 * Stripe account sells other products; they must never unlock rigor Pro).
 */
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("./firebase");

const db = admin.firestore();

const SERVICE_NAME = "rigor";

async function handleStripeEvent(event) {
  switch (event.type) {
    // ── Checkout completed ─────────────────────────────────────────────────
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription" || !session.subscription) break;
      if (!["paid", "no_payment_required"].includes(session.payment_status)) break;

      // Plan first: the MDO3 account sells other products, and a non-rigor price
      // must never grant anything or be parked as a rigor payment.
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = resolvePlan(priceId);
      if (!plan) { console.warn(`checkout ${session.id}: unknown price ${priceId}; not granting`); break; }

      // Q7: who paid? Embedded checkout carries metadata.userId (verified token).
      // A Stripe Payment Link session carries at most client_reference_id, or only
      // the payer's email. Unmatched payments are parked for /api/payment/confirm.
      const userId = await resolveCheckoutUser(session);
      if (!userId) {
        await parkUnclaimed(session, subscription, priceId, plan);
        await logEvent(event.id, null, "payment_unclaimed", { plan, sessionId: session.id });
        break;
      }

      await grantFromSubscription(userId, event, session, subscription, plan);
      await logEvent(event.id, userId, "subscription_created", { plan });
      break;
    }

    // ── Subscription updated ───────────────────────────────────────────────
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const userId = await getUserIdFromCustomer(sub.customer);
      if (!userId) break;

      const priceId = sub.items.data[0]?.price?.id;
      const plan = resolvePlan(priceId);
      const status = sub.status; // active, trialing, past_due, canceled, etc.
      const paidNow = (status === "active" || status === "trialing") && plan;

      await writeSub(userId, event, {
        plan: paidNow ? plan : "free",
        status,
        stripePriceId: priceId,
        currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: sub.cancel_at_period_end
      });

      await logEvent(event.id, userId, "subscription_updated", { plan, status });
      break;
    }

    // ── Subscription deleted / cancelled ──────────────────────────────────
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const userId = await getUserIdFromCustomer(sub.customer);
      if (!userId) break;

      await writeSub(userId, event, {
        plan: "free",
        status: "canceled",
        canceledAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await logEvent(event.id, userId, "subscription_canceled", {});
      break;
    }

    // ── Invoice paid ──────────────────────────────────────────────────────
    case "invoice.paid": {
      const invoice = event.data.object;
      const userId = await getUserIdFromCustomer(invoice.customer);
      if (!userId) break;

      await writeSub(userId, event, {
        status: "active",
        lastPaymentDate: new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      });
      break;
    }

    // ── Payment failed ─────────────────────────────────────────────────────
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const userId = await getUserIdFromCustomer(invoice.customer);
      if (!userId) break;

      await writeSub(userId, event, {
        status: "past_due"
      });

      await logEvent(event.id, userId, "payment_failed", { invoiceId: invoice.id });
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }
}

/**
 * True when the event belongs to rigor: serviceName 'rigor' on the object (or the
 * invoice's subscription snapshot), or — for subscriptions created before
 * serviceName was set — a price id from STRIPE_PRO_PRICE_IDS / STRIPE_TEAM_PRICE_IDS.
 */
function isRigorEvent(event) {
  const obj = event?.data?.object || {};
  const names = [
    obj.metadata?.serviceName,
    obj.subscription_details?.metadata?.serviceName,
    obj.parent?.subscription_details?.metadata?.serviceName,
    obj.lines?.data?.[0]?.metadata?.serviceName
  ];
  if (names.includes(SERVICE_NAME)) return true;
  // Q7: Payment Link sessions (no serviceName) — the rigor link, or the
  // stripe-hub convention client_reference_id "rigor:<uid>".
  if (obj.object === "checkout.session") {
    if (obj.payment_link && paymentLinkIds().includes(obj.payment_link)) return true;
    if (typeof obj.client_reference_id === "string" && obj.client_reference_id.startsWith(`${SERVICE_NAME}:`)) return true;
  }
  if (names.some(Boolean)) return false; // explicitly another service
  const known = [process.env.STRIPE_PRO_PRICE_IDS, process.env.STRIPE_TEAM_PRICE_IDS]
    .join(",").split(",").map(s => s.trim()).filter(Boolean);
  const prices = [
    ...(obj.items?.data || []).map(i => i.price?.id),
    ...(obj.lines?.data || []).map(l => l.price?.id || l.pricing?.price_details?.price)
  ].filter(Boolean);
  return prices.some(p => known.includes(p));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Rigor's Stripe Payment Link(s) (public ids, not secrets). Default = the live
// "Rigor Pro" $9.99/mo link; override with RIGOR_PAYMENT_LINK_IDS (comma-separated).
const DEFAULT_PAYMENT_LINK_IDS = "plink_1TEwCoCRLa19N9qBx7eNHK7D";
function paymentLinkIds() {
  return (process.env.RIGOR_PAYMENT_LINK_IDS || DEFAULT_PAYMENT_LINK_IDS)
    .split(",").map(s => s.trim()).filter(Boolean);
}

const UID_RE = /^[A-Za-z0-9]{1,128}$/;

// client_reference_id may be "<uid>" or the stripe-hub form "rigor:<uid>".
function uidFromReference(ref) {
  if (typeof ref !== "string" || !ref) return null;
  const v = ref.startsWith(`${SERVICE_NAME}:`) ? ref.slice(SERVICE_NAME.length + 1) : ref;
  return UID_RE.test(v) ? v : null;
}

/**
 * The Firebase uid a completed checkout belongs to, or null.
 *  1. metadata.userId (embedded checkout; set from the verified ID token)
 *  2. client_reference_id, only if that Firebase user exists
 *  3. the payer's email, only if it matches a Firebase user with a VERIFIED email
 *     (an unverified account could have been registered with someone else's email)
 */
async function resolveCheckoutUser(session) {
  const meta = session.metadata?.userId;
  if (meta && meta !== "anonymous" && UID_RE.test(meta)) return meta;
  const auth = admin.auth();
  const ref = uidFromReference(session.client_reference_id);
  if (ref) {
    try { await auth.getUser(ref); return ref; } catch { /* unknown uid: fall through */ }
  }
  const email = session.customer_details?.email || session.customer_email;
  if (email) {
    try {
      const u = await auth.getUserByEmail(email);
      if (u?.emailVerified) return u.uid;
    } catch { /* no such user */ }
  }
  return null;
}

// Write subscriptions/{uid} from the live subscription object (webhook or confirm).
async function grantFromSubscription(userId, event, session, subscription, plan) {
  await writeSub(userId, event, {
    plan,
    status: subscription.status || "active",
    stripeCustomerId: session.customer || subscription.customer,
    stripeSubscriptionId: subscription.id || session.subscription,
    stripePriceId: subscription.items?.data?.[0]?.price?.id || null,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    checkoutSessionId: session.id
  });
  await db.collection("unclaimed_payments").doc(session.id)
    .set({ claimed: true, claimedBy: userId, claimedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});
}

// A paid rigor checkout nobody could be matched to (server-only collection).
async function parkUnclaimed(session, subscription, priceId, plan) {
  await db.collection("unclaimed_payments").doc(session.id).set({
    claimed: false,
    plan,
    priceId,
    email: session.customer_details?.email || session.customer_email || null,
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: subscription.id || session.subscription,
    paymentLink: session.payment_link || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

function resolvePlan(priceId) {
  const proPriceIds = (process.env.STRIPE_PRO_PRICE_IDS || "").split(",").map(s => s.trim());
  const teamPriceIds = (process.env.STRIPE_TEAM_PRICE_IDS || "").split(",").map(s => s.trim());
  if (teamPriceIds.includes(priceId)) return "team";
  if (proPriceIds.includes(priceId)) return "pro";
  return null; // unknown price: grant nothing
}

// Merge-write subscriptions/{userId} unless a newer Stripe event was already applied.
async function writeSub(userId, event, data) {
  const ref = db.collection("subscriptions").doc(userId);
  const created = Number(event?.created) || 0;
  await db.runTransaction(async t => {
    const snap = await t.get(ref);
    const last = snap.exists ? Number(snap.data().lastEventCreated) || 0 : 0;
    if (created && last && created < last) {
      console.log(`stale ${event.type} ${event.id} for ${userId} skipped (${created} < ${last})`);
      return;
    }
    t.set(ref, {
      ...data,
      lastEventCreated: Math.max(created, last),
      lastEventId: event?.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function getUserIdFromCustomer(customerId) {
  const snap = await db.collection("subscriptions")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id; // doc ID is userId
}

// Keyed by Stripe event id so a redelivered / double-delivered event (direct
// endpoint + stripe-hub during migration) overwrites instead of adding a row.
async function logEvent(eventId, userId, type, data) {
  const doc = { userId, type, data, eventId, createdAt: admin.firestore.FieldValue.serverTimestamp() };
  if (eventId) await db.collection("payment_events").doc(eventId).set(doc);
  else await db.collection("payment_events").add(doc);
}

module.exports = {
  handleStripeEvent, isRigorEvent, resolvePlan, resolveCheckoutUser, grantFromSubscription,
  uidFromReference, paymentLinkIds, writeSub, SERVICE_NAME, stripe
};
