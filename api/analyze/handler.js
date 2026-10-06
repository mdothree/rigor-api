/**
 * /api/analyze/handler.js
 * Resume analysis via Claude API.
 * Requires a verified Firebase ID token like every other AI handler (the resume
 * frontend already requires sign-in); anonymous calls were an open Anthropic-spend hole.
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");
const { withRateLimit, withInputCaps } = require("../_middleware/limits");
const admin = require("../lib/firebase");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Server-side length caps (truncate) mirror the client limits (resume app.js RESUME_LIMIT/JD_LIMIT).
const CAPS = { resume: 4000, jobDescription: 2000 };

module.exports = withCors(requireAuth(withRateLimit(withInputCaps(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { resume, jobDescription } = req.body;
    if (!resume || !jobDescription) {
      return res.status(400).json({ error: "Missing resume or jobDescription" });
    }

    const userId = req.user.uid; // set by requireAuth

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `You are an expert ATS resume analyzer. Analyze this resume against the job description and respond ONLY with valid JSON matching this exact structure:

{
  "score": <integer 0-100>,
  "missingKeywords": [<up to 8 strings>],
  "strengths": [<3-5 strings>],
  "recommendations": [<4-6 actionable strings>]
}

RESUME:
${resume.slice(0, 4000)}

JOB DESCRIPTION:
${jobDescription.slice(0, 2000)}`
      }]
    });

    const text = message.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const data = JSON.parse(clean);

    // Usage is counted here only (single source of truth). The client gate no longer
    // increments it, and firestore.rules deny client writes to usage/.
    const db = admin.firestore();
    const month = new Date().toISOString().slice(0, 7);
    const ref = db.doc(`usage/${userId}_${month}`);
    await ref.set({ analyses: admin.firestore.FieldValue.increment(1), userId, month }, { merge: true });

    res.status(200).json(data);
  } catch (err) {
    console.error("analyze error:", err);
    res.status(500).json({ error: err.message });
  }
}, CAPS), { name: "analyze" })));
