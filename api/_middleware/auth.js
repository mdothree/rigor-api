/**
 * _middleware/auth.js — Firebase ID token verification (+ optional App Check)
 *
 * requireAuth(handler):
 *   - 401 unless `Authorization: Bearer <Firebase ID token>` verifies against
 *     mdo3d-career (firebase-admin verifyIdToken checks signature, expiry, aud/iss).
 *   - 401 for anonymous-auth tokens: rigor only offers email/password accounts, and
 *     anonymous tokens can be minted by anyone with the public web API key, which
 *     would reset the free quota per throwaway uid.
 *   - App Check: when the client sends X-Firebase-AppCheck it is verified; when
 *     APPCHECK_ENFORCE=true a missing/invalid token is a 401. Default: not enforced.
 *   - Handler errors are NOT reported as "Invalid token" (the handler runs outside
 *     the verification try/catch).
 */
const admin = require("../lib/firebase");

async function verifyToken(token) {
  return admin.auth().verifyIdToken(token);
}

function isAnonymousToken(decoded) {
  return decoded?.firebase?.sign_in_provider === "anonymous";
}

async function checkAppCheck(req) {
  const enforce = process.env.APPCHECK_ENFORCE === "true";
  const token = req.headers["x-firebase-appcheck"];
  if (!token) return !enforce;
  try {
    req.appCheck = await admin.appCheck().verifyToken(String(token));
    return true;
  } catch {
    return !enforce; // monitor mode: ignore bad tokens unless enforcing
  }
}

function requireAuth(handler) {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let decoded;
    try {
      decoded = await verifyToken(authHeader.slice(7).trim());
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
    if (isAnonymousToken(decoded)) {
      return res.status(401).json({ error: "Please sign in with your rigor account." });
    }
    if (!(await checkAppCheck(req))) {
      return res.status(401).json({ error: "App verification failed. Reload the page and try again." });
    }
    req.user = decoded;
    return handler(req, res);
  };
}

module.exports = { verifyToken, requireAuth, isAnonymousToken };
