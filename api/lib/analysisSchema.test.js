// FS-NF-03: run with `node --test api/lib/analysisSchema.test.js`
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAnalysis } = require("./analysisSchema");

const good = { score: 72, missingKeywords: ["a"], strengths: ["s"], recommendations: ["r"] };

test("accepts a complete analysis and rounds the score", () => {
  const r = validateAnalysis({ ...good, score: 71.6 });
  assert.equal(r.ok, true); assert.equal(r.data.score, 72);
});
test("null, empty, boolean, array and out-of-range scores are not zero", () => {
  for (const score of [null, "", undefined, true, [], {}, "abc", -1, 101, NaN]) {
    assert.equal(validateAnalysis({ ...good, score }).ok, false, String(score));
  }
});
test("missing or non-array recommendations/strengths fail", () => {
  assert.equal(validateAnalysis({ ...good, recommendations: "do x" }).ok, false);
  assert.equal(validateAnalysis({ ...good, recommendations: [] }).ok, false);
  assert.equal(validateAnalysis({ ...good, strengths: undefined }).ok, false);
  assert.equal(validateAnalysis({ ...good, missingKeywords: "x" }).ok, false);
});
test("non-objects fail", () => {
  for (const v of [null, 5, "x", []]) assert.equal(validateAnalysis(v).ok, false);
});
