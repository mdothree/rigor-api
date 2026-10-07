/**
 * _middleware/cors.js — CORS for the rigor.design frontends.
 * The tool frontends (resume./cover./interview./... .rigor.design) call
 * https://api.rigor.design cross-origin with an Authorization header, which
 * triggers a preflight OPTIONS. Answer it here, BEFORE requireAuth (which would
 * otherwise 401 the preflight with no CORS headers and the browser blocks the call).
 * Explicit allowlist only — no wildcard / reflected origins.
 */
const ALLOWED_ORIGINS = new Set([
  "https://rigor.design",
  "https://www.rigor.design",
  "https://resume.rigor.design",
  "https://cover.rigor.design",
  "https://interview.rigor.design",
  "https://linkedin.rigor.design",
  "https://networking.rigor.design",
  "https://portfolio.rigor.design",
  "https://salary.rigor.design"
]);

function withCors(handler) {
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Firebase-AppCheck");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(204).end();
    return handler(req, res);
  };
}

module.exports = { withCors, ALLOWED_ORIGINS };
