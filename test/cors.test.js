const test = require("node:test");
const assert = require("node:assert");
const { withCors, ALLOWED_ORIGINS } = require("../api/_middleware/cors");

const subs = ["resume", "cover", "interview", "linkedin", "networking", "portfolio", "salary"];
const hosts = ["rigor.design", "rigorcareer.com"];

test("allowlist has apex, www and every tool origin on both domains", () => {
  for (const h of hosts) {
    assert.ok(ALLOWED_ORIGINS.has("https://" + h), h);
    assert.ok(ALLOWED_ORIGINS.has("https://www." + h), "www." + h);
    for (const s of subs) assert.ok(ALLOWED_ORIGINS.has("https://" + s + "." + h), s + "." + h);
  }
});

test("withCors echoes allowed rigorcareer.com origin, not unknown origins", async () => {
  const run = async (origin) => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, status() { return this; }, end() { return this; } };
    await withCors(async () => {})({ headers: { origin }, method: "OPTIONS" }, res);
    return headers["Access-Control-Allow-Origin"];
  };
  assert.strictEqual(await run("https://salary.rigorcareer.com"), "https://salary.rigorcareer.com");
  assert.strictEqual(await run("https://salary.rigor.design"), "https://salary.rigor.design");
  assert.strictEqual(await run("https://evil.example"), undefined);
});
