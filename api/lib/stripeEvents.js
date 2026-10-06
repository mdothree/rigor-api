/**
 * lib/stripeEvents.js — Stripe event -> Firestore subscription sync.
 * Shared by /api/payment/webhook (direct, signature-verified) and
 * /api/payment/webhook-forwarded (stripe-hub; event re-fetched from Stripe).
 *
 * Idempotency: every write is a merge-set of the same values for the same event,
 * and payment_events rows are keyed by event id, so reprocessing an event is safe.
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
      const userId = session.metadata?.userId;
      if (!userId || userId === "anonymous") break;

      // Get subscription details
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = resolvePlan(priceId);

      await db.collection("subscriptions").doc(userId).set({
        plan,
        status: "active",
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        stripePriceId: priceId,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

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
      const status = sub.status; // active, past_due, canceled, etc.

      await db.collection("subscriptions").doc(userId).set({
        plan: status === "active" ? plan : "free",
        status,
        stripePriceId: priceId,
        currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await logEvent(event.id, userId, "subscription_updated", { plan, status });
      break;
    }

    // ── Subscription deleted / cancelled ──────────────────────────────────
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const userId = await getUserIdFromCustomer(sub.customer);
      if (!userId) break;

      await db.collection("subscriptions").doc(userId).set({
        plan: "free",
        status: "canceled",
        canceledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await logEvent(event.id, userId, "subscription_canceled", {});
      break;
    }

    // ── Invoice paid ──────────────────────────────────────────────────────
    case "invoice.paid": {
      const invoice = event.data.object;
      const userId = await getUserIdFromCustomer(invoice.customer);
      if (!userId) break;

      await db.collection("subscriptions").doc(userId).set({
        status: "active",
        lastPaymentDate: new Date(invoice.status_transitions.paid_at * 1000).toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      break;
    }

    // ── Payment failed ─────────────────────────────────────────────────────
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const userId = await getUserIdFromCustomer(invoice.customer);
      if (!userId) break;

      await db.collection("subscriptions").doc(userId).set({
        status: "past_due",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

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
function resolvePlan(priceId) {
  const proPriceIds = (process.env.STRIPE_PRO_PRICE_IDS || "").split(",").map(s => s.trim());
  const teamPriceIds = (process.env.STRIPE_TEAM_PRICE_IDS || "").split(",").map(s => s.trim());
  if (teamPriceIds.includes(priceId)) return "team";
  if (proPriceIds.includes(priceId)) return "pro";
  return "pro"; // default to pro for any paid plan
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

module.exports = { handleStripeEvent, isRigorEvent, SERVICE_NAME, stripe };
