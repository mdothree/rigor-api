/**
 * /api/lib/analysisSchema.js — FS-NF-03.
 * Valid JSON is not a valid analysis. The model must return a finite 0-100 score and non-empty string arrays for
 * strengths and recommendations; anything else is a failed analysis (502, so withQuota releases the reserved use)
 * instead of a plausible completed score.
 */
function isStringArray(a) { return Array.isArray(a) && a.every(x => typeof x === "string"); }

function validateAnalysis(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "not an object" };
  const s = data.score;
  const score = typeof s === "number" ? s : (typeof s === "string" && s.trim() !== "" ? Number(s) : NaN);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ok: false, error: "score missing or out of range" };
  if (!isStringArray(data.strengths) || data.strengths.length === 0) return { ok: false, error: "strengths missing" };
  if (!isStringArray(data.recommendations) || data.recommendations.length === 0) return { ok: false, error: "recommendations missing" };
  const kw = data.missingKeywords;
  if (kw !== undefined && !isStringArray(kw)) return { ok: false, error: "missingKeywords malformed" };
  return {
    ok: true,
    data: {
      score: Math.round(score),
      missingKeywords: (kw || []).slice(0, 8),
      strengths: data.strengths.slice(0, 5),
      recommendations: data.recommendations.slice(0, 6),
    },
  };
}

module.exports = { validateAnalysis };
