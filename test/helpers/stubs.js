/**
 * test/helpers/stubs.js — in-process fakes so the API handlers can be exercised
 * with node:test and NO dependencies or network:
 *   - api/lib/firebase.js  -> fake firebase-admin (auth tokens + in-memory Firestore)
 *   - "stripe"             -> fake client recording checkout.sessions.create params
 *   - "@anthropic-ai/sdk"  -> fake client counting model calls
 * Require this module BEFORE any api/ module.
 */
const Module = require("module");
const path = require("path");

const state = {
  tokens: new Map(),        // bearer token -> decoded token
  subscriptions: new Map(), // uid -> subscriptions/{uid} doc
  usage: new Map(),         // "usage/{uid}_{month}" -> doc
  checkoutCalls: [],        // params passed to stripe.checkout.sessions.create
  modelCalls: 0             // anthropic messages.create calls
};

// ─── Fake Firestore ───────────────────────────────────────────────────────────
const FieldValue = {
  increment: n => ({ __increment: n }),
  serverTimestamp: () => ({ __serverTimestamp: true })
};

function applySet(store, key, data) {
  const cur = { ...(store.get(key) || {}) };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "__increment" in v) cur[k] = Number(cur[k] || 0) + v.__increment;
    else cur[k] = v;
  }
  store.set(key, cur);
}

const snap = d => ({ exists: d !== undefined, data: () => d });

function docRef(p) {
  return {
    path: p,
    get: async () => snap(state.usage.get(p)),
    set: async data => applySet(state.usage, p, data)
  };
}

const db = {
  collection: name => ({
    doc: id => ({
      path: `${name}/${id}`,
      get: async () => snap(name === "subscriptions" ? state.subscriptions.get(id) : undefined),
      set: async data => { if (name === "subscriptions") applySet(state.subscriptions, id, data); }
    })
  }),
  doc: docRef,
  runTransaction: async fn => fn({
    get: async ref => ref.get(),
    set: (ref, data) => applySet(state.usage, ref.path, data)
  })
};

const fakeAdmin = {
  apps: [{}],
  firestore: Object.assign(() => db, { FieldValue }),
  auth: () => ({
    verifyIdToken: async token => {
      if (!state.tokens.has(token)) throw new Error("invalid token");
      return state.tokens.get(token);
    }
  }),
  appCheck: () => ({ verifyToken: async () => ({}) })
};

// ─── Fake Stripe / Anthropic ──────────────────────────────────────────────────
function fakeStripe() {
  return {
    checkout: {
      sessions: {
        create: async params => {
          state.checkoutCalls.push(params);
          return { id: "cs_stub", client_secret: "cs_stub_secret" };
        }
      }
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://example.invalid/portal" }) } },
    subscriptions: { retrieve: async () => ({}) },
    events: { retrieve: async () => ({}) },
    webhooks: { constructEvent: () => { throw new Error("not stubbed"); } }
  };
}

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async () => {
        state.modelCalls++;
        return { content: [{ text: JSON.stringify({ score: 77, missingKeywords: [], strengths: ["a"], recommendations: ["b"] }) }] };
      }
    };
  }
}

// Install: firebase via require.cache, packages via Module._load.
const firebasePath = path.resolve(__dirname, "../../api/lib/firebase.js");
const m = new Module(firebasePath);
m.filename = firebasePath;
m.loaded = true;
m.exports = fakeAdmin;
require.cache[firebasePath] = m;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "stripe") return fakeStripe;
  if (request === "@anthropic-ai/sdk") return FakeAnthropic;
  if (request === "firebase-admin") return fakeAdmin;
  return origLoad.call(this, request, parent, isMain);
};

// ─── Request / response helpers ───────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end() { this.ended = true; return this; }
  };
}

function mockReq({ token, body = {}, method = "POST", origin = "https://resume.rigor.design" } = {}) {
  const headers = { origin };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, headers, body, socket: { remoteAddress: "127.0.0.1" } };
}

function reset() {
  state.tokens.clear();
  state.subscriptions.clear();
  state.usage.clear();
  state.checkoutCalls.length = 0;
  state.modelCalls = 0;
  try { require("../../api/_middleware/limits")._buckets.clear(); } catch { /* not loaded yet */ }
}

module.exports = { state, mockReq, mockRes, reset, fakeAdmin };
