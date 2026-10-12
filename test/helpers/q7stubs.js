/**
 * test/helpers/q7stubs.js — fakes for the Q7 paid-path tests (no network, no keys):
 * a generic in-memory Firestore (collections, where/limit, transactions), Firebase
 * Auth users, and a Stripe fake whose sessions/subscriptions/events come from
 * `state`. Require BEFORE any api/ module.
 */
const Module = require("module");
const path = require("path");

const state = {
  tokens: new Map(), users: new Map(), docs: new Map(),
  sessions: new Map(), subscriptions: new Map(), events: new Map(),
  checkoutCalls: [], modelCalls: 0
};
const FieldValue = { increment: n => ({ __inc: n }), serverTimestamp: () => "ts" };

function merge(key, data, mergeMode) {
  const cur = mergeMode ? { ...(state.docs.get(key) || {}) } : {};
  for (const [k, v] of Object.entries(data)) cur[k] = v && typeof v === "object" && "__inc" in v ? Number(cur[k] || 0) + v.__inc : v;
  state.docs.set(key, cur);
}
const snap = (id, d) => ({ id, exists: d !== undefined, data: () => d });
function ref(p) {
  const id = p.split("/").pop();
  return { path: p, id, get: async () => snap(id, state.docs.get(p)), set: async (d, o) => merge(p, d, o && o.merge) };
}
function collection(name) {
  const filters = []; let lim = Infinity;
  const q = {
    doc: id => ref(`${name}/${id}`),
    where: (f, op, v) => { filters.push([f, v]); return q; },
    limit: n => { lim = n; return q; },
    add: async d => merge(`${name}/auto${state.docs.size}`, d),
    get: async () => {
      const docs = [...state.docs.entries()]
        .filter(([k, d]) => k.startsWith(name + "/") && filters.every(([f, v]) => d[f] === v))
        .slice(0, lim).map(([k, d]) => snap(k.split("/").pop(), d));
      return { empty: docs.length === 0, docs };
    }
  };
  return q;
}
const db = {
  collection, doc: ref,
  runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => merge(r.path, d, o && o.merge) })
};
const fakeAdmin = {
  apps: [{}],
  firestore: Object.assign(() => db, { FieldValue }),
  auth: () => ({
    verifyIdToken: async t => { if (!state.tokens.has(t)) throw new Error("bad"); return state.tokens.get(t); },
    getUser: async uid => { if (!state.users.has(uid)) throw new Error("no user"); return state.users.get(uid); },
    getUserByEmail: async e => { const u = [...state.users.values()].find(x => x.email === e); if (!u) throw new Error("no user"); return u; }
  }),
  appCheck: () => ({ verifyToken: async () => ({}) })
};
const notFound = () => Object.assign(new Error("No such"), { statusCode: 404 });
function fakeStripe() {
  return {
    checkout: { sessions: {
      create: async p => { state.checkoutCalls.push(p); return { id: "cs_test_stub", client_secret: "cs_test_stub_secret" }; },
      retrieve: async id => { if (!state.sessions.has(id)) throw notFound(); return state.sessions.get(id); }
    } },
    subscriptions: { retrieve: async id => { if (!state.subscriptions.has(id)) throw notFound(); return state.subscriptions.get(id); } },
    events: { retrieve: async id => { if (!state.events.has(id)) throw notFound(); return state.events.get(id); } },
    billingPortal: { sessions: { create: async () => ({ url: "https://example.invalid/portal" }) } },
    webhooks: { constructEvent: (raw, sig) => { if (sig !== "good") throw new Error("bad signature"); return JSON.parse(raw.toString()); } }
  };
}
class FakeAnthropic { constructor() { this.messages = { create: async () => { state.modelCalls++; return { content: [{ text: '{"score":1,"missingKeywords":[],"strengths":[],"recommendations":[]}' }] }; } }; } }

const fp = path.resolve(__dirname, "../../api/lib/firebase.js");
const m = new Module(fp); m.filename = fp; m.loaded = true; m.exports = fakeAdmin; require.cache[fp] = m;
const orig = Module._load;
Module._load = function (r, p, i) {
  if (r === "stripe") return fakeStripe;
  if (r === "@anthropic-ai/sdk") return FakeAnthropic;
  if (r === "firebase-admin") return fakeAdmin;
  return orig.call(this, r, p, i);
};

function res() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { return this; } };
}
function req({ token, body = {}, method = "POST", url = "/", query = {}, headers = {} } = {}) {
  const h = { origin: "https://resume.rigor.design", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return { method, url, query, headers: h, body, socket: { remoteAddress: "127.0.0.1" } };
}
function reset() {
  for (const k of ["tokens", "users", "docs", "sessions", "subscriptions", "events"]) state[k].clear();
  state.checkoutCalls.length = 0; state.modelCalls = 0;
  try { require("../../api/_middleware/limits")._buckets.clear(); } catch { /* not loaded */ }
}
module.exports = { state, req, res, reset };
