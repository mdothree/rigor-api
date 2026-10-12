/**
 * JARVIS #94 — paid from first use (no unpaid allowance), promo codes at checkout.
 * Run: npm test  (node:test; Firebase/Stripe/Anthropic stubbed, no network)
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { state, mockReq, mockRes, reset } = require("./helpers/stubs");

const analyze = require("../api/analyze/handler");
const feedback = require("../api/interview/feedback");
const checkout = require("../api/payment/create-embedded-session");
const quota = require("../api/lib/quota");
const { resolvePlan } = require("../api/lib/stripeEvents");

const RESUME = "experienced engineer ".repeat(40);
const JD = "senior engineer role ".repeat(20);
const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();

function user(uid, { provider = "password" } = {}) {
  const token = `tok_${uid}`;
  state.tokens.set(token, { uid, firebase: { sign_in_provider: provider } });
  return token;
}

beforeEach(() => {
  reset();
  delete process.env.RIGOR_INCLUDED_ANALYSES;
  process.env.RIGOR_FREE_MONTHLY_LIMIT = "3";   // legacy var left in env must NOT re-open an allowance
  process.env.RIGOR_FREE_FEEDBACK_LIMIT = "30";
  process.env.STRIPE_PRO_PRICE_IDS = "price_pro_stub";
  process.env.STRIPE_TEAM_PRICE_IDS = "price_team_stub";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_dummy"; // Q7: checkout returns it (503 without)
});

test("allowance is a single config value, 0 by default, legacy RIGOR_FREE_* ignored", () => {
  assert.equal(quota.INCLUDED_ANALYSES, 0);
  assert.equal(quota.includedLimit("analyses"), 0);
  assert.equal(quota.includedLimit("interviewFeedback"), 0);
  process.env.RIGOR_INCLUDED_ANALYSES = "2";
  assert.equal(quota.includedLimit("analyses"), 2, "reversible via RIGOR_INCLUDED_ANALYSES");
});

test("unsubscribed user: first analysis is 402 subscription_required, no model call, no usage write", async () => {
  const token = user("u_unsub");
  const res = mockRes();
  await analyze(mockReq({ token, body: { resume: RESUME, jobDescription: JD } }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, "subscription_required");
  assert.equal(res.body.checkout, true);
  assert.equal(state.modelCalls, 0);
  assert.equal(state.usage.size, 0);
});

test("unsubscribed user: interview feedback is also 402 subscription_required", async () => {
  const token = user("u_unsub_fb");
  const res = mockRes();
  await feedback(mockReq({ token, body: { question: "Tell me about yourself", answer: "I build reliable systems for people", role: "Engineer" } }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, "subscription_required");
  assert.equal(res.body.checkout, true);
  assert.equal(state.modelCalls, 0);
});

test("inactive / expired / unknown-plan subscriptions do not unlock (402)", async () => {
  const cases = {
    u_canceled: { plan: "pro", status: "canceled" },
    u_pastdue: { plan: "pro", status: "past_due" },
    u_expired: { plan: "pro", status: "active", currentPeriodEnd: new Date(Date.now() - 10 * 864e5).toISOString() },
    u_unknownplan: { plan: "free", status: "active" },
    u_other: { plan: "enterprise", status: "active" }
  };
  for (const [uid, sub] of Object.entries(cases)) {
    state.subscriptions.set(uid, sub);
    const res = mockRes();
    await analyze(mockReq({ token: user(uid), body: { resume: RESUME, jobDescription: JD } }), res);
    assert.equal(res.statusCode, 402, uid);
    assert.equal(res.body.error, "subscription_required", uid);
  }
  assert.equal(state.modelCalls, 0);
});

test("unknown Stripe price resolves to no plan (webhook grants nothing)", () => {
  assert.equal(resolvePlan("price_someone_else"), null);
  assert.equal(resolvePlan("price_pro_stub"), "pro");
  assert.equal(resolvePlan("price_team_stub"), "team");
});

test("subscribed (pro active / team trialing) user is allowed and usage is counted", async () => {
  state.subscriptions.set("u_pro", { plan: "pro", status: "active", currentPeriodEnd: FUTURE });
  state.subscriptions.set("u_team", { plan: "team", status: "trialing" });
  for (const uid of ["u_pro", "u_team"]) {
    const res = mockRes();
    await analyze(mockReq({ token: user(uid), body: { resume: RESUME, jobDescription: JD } }), res);
    assert.equal(res.statusCode, 200, uid);
    assert.equal(res.body.score, 77);
    const doc = state.usage.get(`usage/${uid}_${quota.monthKey()}`);
    assert.equal(doc.analyses, 1, `${uid} counted`);
  }
  assert.equal(state.modelCalls, 2);
});

test("anonymous / missing / invalid tokens are rejected with 401 before quota or model", async () => {
  const anon = user("u_anon", { provider: "anonymous" });
  for (const token of [anon, undefined, "tok_bogus"]) {
    const res = mockRes();
    await analyze(mockReq({ token, body: { resume: RESUME, jobDescription: JD } }), res);
    assert.equal(res.statusCode, 401, String(token));
  }
  assert.equal(state.modelCalls, 0);
});

test("withQuota without a verified uid is 401", async () => {
  const h = quota.withQuota(async (req, res) => res.status(200).json({ ok: true }));
  const res = mockRes();
  await h({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("non-zero allowance (rollback path) still meters and then returns subscription_required", async () => {
  process.env.RIGOR_INCLUDED_ANALYSES = "1";
  const token = user("u_rollback");
  const r1 = mockRes();
  await analyze(mockReq({ token, body: { resume: RESUME, jobDescription: JD } }), r1);
  assert.equal(r1.statusCode, 200);
  const r2 = mockRes();
  await analyze(mockReq({ token, body: { resume: RESUME, jobDescription: JD } }), r2);
  assert.equal(r2.statusCode, 402);
  assert.equal(r2.body.error, "subscription_required");
  assert.equal(r2.body.checkout, true);
});

test("checkout session params include allow_promotion_codes: true (stubbed Stripe, no API call)", async () => {
  const token = user("u_buyer");
  const res = mockRes();
  await checkout(mockReq({ token, body: { priceId: "price_pro_stub" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.checkoutCalls.length, 1);
  const p = state.checkoutCalls[0];
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.mode, "subscription");
  assert.deepEqual(p.line_items, [{ price: "price_pro_stub", quantity: 1 }]);
  assert.equal(p.metadata.userId, "u_buyer");
});

test("checkout refuses unknown prices and anonymous callers", async () => {
  const r1 = mockRes();
  await checkout(mockReq({ token: user("u_x"), body: { priceId: "price_someone_else" } }), r1);
  assert.equal(r1.statusCode, 400);
  const r2 = mockRes();
  await checkout(mockReq({ token: user("u_anon2", { provider: "anonymous" }), body: { priceId: "price_pro_stub" } }), r2);
  assert.equal(r2.statusCode, 401);
  assert.equal(state.checkoutCalls.length, 0);
});
