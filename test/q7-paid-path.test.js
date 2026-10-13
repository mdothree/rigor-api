/**
 * Q7 — the paid path end to end (stubbed Stripe/Firebase; dummy keys; no network):
 * health, checkout (alias, publishable key, client_reference_id, 409), webhook for
 * embedded AND Payment Link sessions (reference / verified email / parked), the
 * hub route, confirm (grant, ownership, pending), and the Hobby function budget.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { state, req, res, reset } = require("./helpers/q7stubs");

const account = require("../api/payment/account");
const checkout = require("../api/payment/create-embedded-session");
const webhook = require("../api/payment/webhook");
const analyze = require("../api/analyze/handler");

const PRO = "price_pro_test_dummy";
const PLINK = "plink_1TEwCoCRLa19N9qBx7eNHK7D";
const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86400;
const ENV = {
  FIREBASE_PROJECT_ID: "x", FIREBASE_CLIENT_EMAIL: "x", FIREBASE_PRIVATE_KEY: "x",
  STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy", STRIPE_PRO_PRICE_IDS: PRO, ANTHROPIC_API_KEY: "dummy"
};

function user(uid, { email, verified = false } = {}) {
  state.users.set(uid, { uid, email, emailVerified: verified });
  state.tokens.set(`tok_${uid}`, { uid, email, firebase: { sign_in_provider: "password" } });
  return `tok_${uid}`;
}
function sub(id, price = PRO, customer = "cus_1") {
  const s = { id, customer, status: "active", current_period_end: FUTURE, items: { data: [{ price: { id: price } }] } };
  state.subscriptions.set(id, s); return s;
}
function session(id, extra = {}) {
  const s = { object: "checkout.session", id, mode: "subscription", status: "complete", payment_status: "paid",
    subscription: "sub_1", customer: "cus_1", metadata: {}, client_reference_id: null, payment_link: null,
    customer_details: { email: "payer@example.com" }, ...extra };
  state.sessions.set(id, s); return s;
}
function event(obj, id = "evt_1", type = "checkout.session.completed") {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object: obj } };
}
async function post(handler, opts) { const r = res(); await handler(req(opts), r); return r; }
async function directWebhook(ev) {
  const r = res();
  await webhook(req({ url: "/api/payment/webhook", body: Buffer.from(JSON.stringify(ev)), headers: { "stripe-signature": "good" } }), r);
  return r;
}
const subDoc = uid => state.docs.get(`subscriptions/${uid}`);

beforeEach(() => { reset(); Object.assign(process.env, ENV); delete process.env.RIGOR_PAYMENT_LINK_IDS; });

test("health: 200 with every required env; 503 naming only booleans when one is missing", async () => {
  let r = await post(account, { method: "GET", url: "/health", query: { op: "health" } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  r = await post(account, { method: "GET", url: "/health", query: { op: "health" } });
  assert.equal(r.statusCode, 503); assert.equal(r.body.checks.webhook, false);
  assert.ok(!JSON.stringify(r.body).includes("sk_test_dummy"), "no values leak");
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy"; process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_dummy";
  r = await post(account, { method: "GET", url: "/health", query: { op: "health" } });
  assert.equal(r.statusCode, 503, "test secret + live publishable key is a misconfiguration");
});

test("health: CORS for allow-listed rigor.design origins only (L-RES-03, read by apiReachable)", async () => {
  let r = await post(account, { method: "GET", url: "/health", query: { op: "health" }, headers: { origin: "https://resume.rigor.design" } });
  assert.equal(r.statusCode, 200); assert.equal(r.headers["access-control-allow-origin"], "https://resume.rigor.design");
  r = await post(account, { method: "GET", url: "/health", query: { op: "health" }, headers: { origin: "https://evil.example" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("OPTIONS preflight is 204 before auth on checkout and confirm", async () => {
  for (const [h, url, query] of [[checkout, "/api/payment/create-embedded-session", {}], [account, "/api/payment/confirm", { op: "confirm" }]]) {
    const r = await post(h, { method: "OPTIONS", url, query });
    assert.equal(r.statusCode, 204, url);
  }
});

test("anonymous analyze is 401; signed-in unsubscribed is 402 subscription_required", async () => {
  let r = await post(analyze, { body: { resume: "r".repeat(200), jobDescription: "j".repeat(200) } });
  assert.equal(r.statusCode, 401);
  r = await post(analyze, { token: user("u1"), body: { resume: "r".repeat(200), jobDescription: "j".repeat(200) } });
  assert.equal(r.statusCode, 402); assert.equal(r.body.error, "subscription_required"); assert.equal(state.modelCalls, 0);
});

test("checkout: alias 'pro' -> configured price, publishable key returned, reference + return_url set", async () => {
  const r = await post(checkout, { token: user("u2", { email: "u2@example.com" }), body: { priceId: "pro" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.publishableKey, "pk_test_dummy");
  const p = state.checkoutCalls[0];
  assert.deepEqual(p.line_items, [{ price: PRO, quantity: 1 }]);
  assert.equal(p.client_reference_id, "rigor:u2");
  assert.equal(p.customer_email, "u2@example.com");
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.return_url, "https://resume.rigor.design/success?session_id={CHECKOUT_SESSION_ID}");
});

test("checkout: unknown price 400, team alias with no team price 400, already-subscribed 409", async () => {
  const t = user("u3");
  assert.equal((await post(checkout, { token: t, body: { priceId: "price_other" } })).statusCode, 400);
  assert.equal((await post(checkout, { token: t, body: { priceId: "team" } })).statusCode, 400);
  state.docs.set("subscriptions/u3", { plan: "pro", status: "active" });
  assert.equal((await post(checkout, { token: t, body: { priceId: "pro" } })).statusCode, 409);
  assert.equal(state.checkoutCalls.length, 0);
});

test("webhook: embedded session (metadata.userId) grants Pro", async () => {
  sub("sub_1");
  const r = await directWebhook(event(session("cs_test_aaaaaaaaaaaaa", { metadata: { userId: "u4", serviceName: "rigor" } })));
  assert.equal(r.statusCode, 200);
  assert.equal(subDoc("u4").plan, "pro"); assert.equal(subDoc("u4").stripeCustomerId, "cus_1");
});

test("webhook: bad signature 400, nothing written", async () => {
  const r = res();
  await webhook(req({ url: "/api/payment/webhook", body: Buffer.from("{}"), headers: { "stripe-signature": "bad" } }), r);
  assert.equal(r.statusCode, 400); assert.equal(state.docs.size, 0);
});

test("webhook: Payment Link session with client_reference_id (raw or rigor:) grants that existing user", async () => {
  user("u5"); sub("sub_1");
  await directWebhook(event(session("cs_test_baaaaaaaaaaaa", { payment_link: PLINK, client_reference_id: "rigor:u5" })));
  assert.equal(subDoc("u5").plan, "pro");
});

test("webhook: Payment Link session matched by VERIFIED email only", async () => {
  user("u6", { email: "payer@example.com", verified: false }); sub("sub_1");
  await directWebhook(event(session("cs_test_caaaaaaaaaaaa", { payment_link: PLINK })));
  assert.equal(subDoc("u6"), undefined, "unverified email does not get someone's payment");
  assert.equal(state.docs.get("unclaimed_payments/cs_test_caaaaaaaaaaaa").claimed, false);
  state.users.get("u6").emailVerified = true;
  await directWebhook(event(session("cs_test_daaaaaaaaaaaa", { payment_link: PLINK }), "evt_2"));
  assert.equal(subDoc("u6").plan, "pro");
});

test("webhook: other products in the account never grant or park", async () => {
  user("u7", { email: "payer@example.com", verified: true }); sub("sub_1", "price_divination");
  await directWebhook(event(session("cs_test_eaaaaaaaaaaaa", { metadata: { userId: "u7" } })));
  assert.equal(subDoc("u7"), undefined);
  assert.equal(state.docs.get("unclaimed_payments/cs_test_eaaaaaaaaaaaa"), undefined);
});

test("hub route: Payment Link session is recognised as rigor and handled; foreign event ignored", async () => {
  user("u8"); sub("sub_1");
  state.events.set("evt_hub1", event(session("cs_test_faaaaaaaaaaaa", { payment_link: PLINK, client_reference_id: "u8" }), "evt_hub1"));
  let r = res();
  await webhook(req({ url: "/api/payment/webhook-forwarded", query: { src: "hub" }, body: { eventId: "evt_hub1" } }), r);
  assert.equal(r.statusCode, 200); assert.equal(subDoc("u8").plan, "pro");
  state.events.set("evt_hub2", event({ object: "checkout.session", id: "cs_x", metadata: { serviceName: "tarot" } }, "evt_hub2"));
  r = res();
  await webhook(req({ url: "/api/payment/webhook-forwarded", query: { src: "hub" }, body: { eventId: "evt_hub2" } }), r);
  assert.equal(r.body.ignored, true);
});

test("confirm: parked Payment Link payment is claimed by the caller, then not by anyone else", async () => {
  sub("sub_1"); session("cs_test_gaaaaaaaaaaaa", { payment_link: PLINK });
  const a = user("u9"), b = user("u10");
  let r = await post(account, { token: a, url: "/api/payment/confirm", query: { op: "confirm" }, body: { sessionId: "cs_test_gaaaaaaaaaaaa" } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.active, true); assert.equal(r.body.plan, "pro");
  r = await post(account, { token: b, url: "/api/payment/confirm", query: { op: "confirm" }, body: { sessionId: "cs_test_gaaaaaaaaaaaa" } });
  assert.equal(r.statusCode, 403); assert.equal(subDoc("u10"), undefined);
});

test("confirm: someone else's embedded session is 403; open session is 202 pending; no session = status", async () => {
  sub("sub_1"); session("cs_test_haaaaaaaaaaaa", { metadata: { userId: "owner" } });
  session("cs_test_iaaaaaaaaaaaa", { status: "open", payment_status: "unpaid", metadata: { userId: "u11" } });
  const t = user("u11");
  let r = await post(account, { token: t, url: "/api/payment/confirm", query: { op: "confirm" }, body: { sessionId: "cs_test_haaaaaaaaaaaa" } });
  assert.equal(r.statusCode, 403);
  r = await post(account, { token: t, url: "/api/payment/confirm", query: { op: "confirm" }, body: { sessionId: "cs_test_iaaaaaaaaaaaa" } });
  assert.equal(r.statusCode, 202); assert.equal(r.body.pending, true);
  r = await post(account, { token: t, url: "/api/payment/confirm", query: { op: "confirm" }, body: {} });
  assert.equal(r.statusCode, 200); assert.equal(r.body.active, false);
  r = await post(account, { url: "/api/payment/confirm", query: { op: "confirm" }, body: {} });
  assert.equal(r.statusCode, 401);
});

test("after a grant, analyze is allowed (Pro unlocks the tools)", async () => {
  sub("sub_1"); await directWebhook(event(session("cs_test_jaaaaaaaaaaaa", { metadata: { userId: "u12" } })));
  const r = await post(analyze, { token: user("u12"), body: { resume: "r".repeat(200), jobDescription: "j".repeat(200) } });
  assert.equal(r.statusCode, 200); assert.equal(state.modelCalls, 1);
});

test("Hobby budget: at most 12 serverless functions, and every route dest exists", () => {
  const root = path.resolve(__dirname, "..");
  const v = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const dirs = ["payment", "analyze", "cover-letter", "interview", "linkedin", "networking", "portfolio", "salary"];
  const fns = dirs.flatMap(d => fs.readdirSync(path.join(root, "api", d)).filter(f => f.endsWith(".js")));
  assert.ok(fns.length <= 12, `${fns.length} functions`);
  for (const r of v.routes) {
    if (r.src === "/api/(.*)") continue;
    assert.ok(fs.existsSync(path.join(root, r.dest.split("?")[0])), r.dest);
  }
});
