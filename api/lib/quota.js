/**
 * lib/quota.js — server-side entitlement + usage metering (the source of truth).
 *
 * JARVIS #94 (paid-only doctrine): there is no unpaid tier. An account without an
 * active paid entitlement gets INCLUDED_ANALYSES AI calls per month, and that
 * value is 0, so every AI call from an unsubscribed account is answered with
 *   402 {error:"subscription_required", checkout:true}
 * before any model call. Early access is granted through Stripe promotion codes
 * at checkout (create-embedded-session sets allow_promotion_codes), not here.
 *
 * Reversible by config, not by code: the allowance is ONE value, INCLUDED_ANALYSES
 * below (overridable with RIGOR_INCLUDED_ANALYSES), applied to every counter. The
 * metering path for a non-zero allowance is kept intact. The legacy env vars
 * RIGOR_FREE_MONTHLY_LIMIT / RIGOR_FREE_FEEDBACK_LIMIT are intentionally IGNORED
 * so a stale value left in the Vercel env cannot silently re-open an allowance.
 *
 * Usage doc: usage/{uid}_{YYYY-MM} (UTC month, same key the clients read for the
 * usage meter; firestore.rules deny client writes to it). Every AI generation
 * increments `analyses` (plus a per-tool counter such as `coverLetters` for
 * reporting); interview answer feedback counts `interviewFeedback`.
 * Pro/Team (subscriptions/{uid} written only by the Stripe webhook, plan pro|team
 * and status active|trialing; unknown prices never grant a plan) are unlimited
 * but still counted.
 *
 * With a non-zero allowance a slot is RESERVED in a transaction before the model
 * call (so concurrent requests cannot overshoot) and RELEASED if the handler ends
 * with an error status, so failed calls never burn quota.
 */
const admin = require("./firebase");

const PAID_PLANS = new Set(["pro", "team"]);
const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // tolerate a late renewal webhook

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// #94: AI calls per month for an account WITHOUT an active paid entitlement.
// 0 = paid from first use. The single switch for the unpaid allowance.
const INCLUDED_ANALYSES = 0;

function includedLimit(_counter) {
  return intEnv("RIGOR_INCLUDED_ANALYSES", INCLUDED_ANALYSES);
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // UTC "YYYY-MM"
}

function isPaidSubscription(s, now = Date.now()) {
  if (!s || !PAID_PLANS.has(s.plan) || !ACTIVE_STATUSES.has(s.status)) return false;
  if (s.currentPeriodEnd) {
    const end = typeof s.currentPeriodEnd.toMillis === "function"
      ? s.currentPeriodEnd.toMillis()
      : Date.parse(s.currentPeriodEnd);
    if (Number.isFinite(end) && end + PERIOD_GRACE_MS < now) return false;
  }
  return true;
}

async function isPaidUser(db, uid) {
  const snap = await db.collection("subscriptions").doc(uid).get();
  return snap.exists ? isPaidSubscription(snap.data()) : false;
}

/**
 * Reserve one unit of `counter` for uid this month.
 * @returns {Promise<{allowed:boolean, used:number, limit:number, paid:boolean, release:Function}>}
 */
async function reserve(uid, counter = "analyses", toolCounter = null) {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;
  const month = monthKey();
  const ref = db.doc(`usage/${uid}_${month}`);
  const paid = await isPaidUser(db, uid);
  const limit = paid ? Infinity : includedLimit(counter);

  const inc = n => {
    const d = { [counter]: FieldValue.increment(n), userId: uid, month, updatedAt: FieldValue.serverTimestamp() };
    if (toolCounter) d[toolCounter] = FieldValue.increment(n);
    return d;
  };
  const release = () => ref.set(inc(-1), { merge: true });

  if (paid) {
    await ref.set(inc(1), { merge: true });
    return { allowed: true, used: null, limit, paid, release };
  }

  // No allowance: refuse without touching the usage doc.
  if (limit <= 0) {
    return { allowed: false, used: 0, limit: 0, paid, release: async () => {} };
  }

  let allowed = false;
  let used = 0;
  await db.runTransaction(async t => {
    const snap = await t.get(ref);
    used = snap.exists ? Number(snap.data()[counter] || 0) : 0;
    if (used >= limit) { allowed = false; return; }
    allowed = true;
    t.set(ref, inc(1), { merge: true });
  });
  return { allowed, used: allowed ? used + 1 : used, limit, paid, release };
}

/**
 * Wrap an AI handler (runs after requireAuth, so req.user.uid is verified).
 * 402 {error:"subscription_required", checkout:true} when the account has no
 * active paid entitlement and no remaining allowance (with INCLUDED_ANALYSES=0:
 * every unsubscribed call); 503 if the subscription/usage store is unreachable
 * (fail closed: no unmetered model calls).
 */
function withQuota(handler, { counter = "analyses", toolCounter = null } = {}) {
  return async (req, res) => {
    if (req.method !== "POST") return handler(req, res);
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    let r;
    try {
      r = await reserve(uid, counter, toolCounter);
    } catch (err) {
      console.error("quota reserve error:", err);
      return res.status(503).json({ error: "Usage service is unavailable. Please try again shortly." });
    }
    if (!r.allowed) {
      return res.status(402).json({
        error: "subscription_required",
        checkout: true,
        message: "Rigor Pro is required to use this tool.",
        used: r.used, limit: r.limit
      });
    }

    let statusCode = 200;
    const origStatus = res.status.bind(res);
    res.status = c => { statusCode = c; return origStatus(c); };
    try {
      return await handler(req, res);
    } catch (err) {
      statusCode = 500;
      throw err;
    } finally {
      if (statusCode >= 400) {
        await r.release().catch(e => console.error("quota release error:", e));
      }
    }
  };
}

module.exports = { withQuota, reserve, isPaidSubscription, isPaidUser, monthKey, includedLimit, INCLUDED_ANALYSES };
