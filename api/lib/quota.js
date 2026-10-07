/**
 * lib/quota.js — server-side monthly usage limits (the source of truth).
 *
 * Usage doc: usage/{uid}_{YYYY-MM} (UTC month, same key the clients read for the
 * paywall meter; firestore.rules deny client writes to it).
 *
 * One SHARED free quota across all seven tools: every AI generation increments
 * `analyses` (plus a per-tool counter such as `coverLetters` for reporting).
 * Free plan: RIGOR_FREE_MONTHLY_LIMIT generations/month (default 3, matching
 * PLANS.free.limits.analyses in the frontends). Interview answer feedback is
 * per-question, so it has its own counter `interviewFeedback`
 * (RIGOR_FREE_FEEDBACK_LIMIT, default 30 = ~3 sessions x 10 questions).
 * Pro/Team (subscriptions/{uid} written only by the Stripe webhook, plan pro|team
 * and status active|trialing) are unlimited but still counted.
 *
 * A slot is RESERVED in a transaction before the model call (so concurrent
 * requests cannot overshoot the limit) and RELEASED if the handler ends with an
 * error status, so failed calls never burn quota.
 */
const admin = require("./firebase");

const PAID_PLANS = new Set(["pro", "team"]);
const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // tolerate a late renewal webhook

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function freeLimit(counter) {
  if (counter === "interviewFeedback") return intEnv("RIGOR_FREE_FEEDBACK_LIMIT", 30);
  return intEnv("RIGOR_FREE_MONTHLY_LIMIT", 3);
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
  const limit = paid ? Infinity : freeLimit(counter);

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
 * 402 {code:"quota_exceeded"} when the free quota is used up; 503 if the usage
 * store is unreachable (fail closed: no unmetered model calls).
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
      const what = counter === "interviewFeedback" ? "answer reviews" : "AI generations";
      return res.status(402).json({
        error: `You've used all ${r.limit} free ${what} for this month. Upgrade to Pro for unlimited use.`,
        code: "quota_exceeded", used: r.used, limit: r.limit
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

module.exports = { withQuota, reserve, isPaidSubscription, monthKey, freeLimit };
