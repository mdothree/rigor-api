/**
 * /api/cover-letter/handler.js
 * AI cover letter generation via Claude
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");
const { withRateLimit, withInputCaps } = require("../_middleware/limits");
const admin = require("../lib/firebase");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Server-side length caps (truncate) mirror the client limits.
const CAPS = { resume: 3000, jobDescription: 2000, tone: 20, companyName: 200, hiringManager: 200 };

module.exports = withCors(requireAuth(withRateLimit(withInputCaps(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { resume, jobDescription, tone = "professional", companyName, hiringManager } = req.body;
  if (!resume || !jobDescription) {
    return res.status(400).json({ error: "resume and jobDescription are required" });
  }

  const userId = req.user.uid;

  try {
    const salutation = hiringManager
      ? `Dear ${hiringManager},`
      : companyName
      ? `Dear ${companyName} Hiring Team,`
      : "Dear Hiring Manager,";

    const toneGuide = {
      professional:  "formal, confident, and polished",
      enthusiastic:  "warm, energetic, and genuinely excited",
      creative:      "distinctive, memorable, and personality-forward",
      concise:       "brief, direct, and impactful — under 250 words",
    }[tone] || "professional";

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: `Write a compelling cover letter. Tone: ${toneGuide}.
Start with: "${salutation}"
End with a professional closing and "Sincerely," signature placeholder.
Do NOT use generic filler phrases. Be specific using details from the resume and job description.
Respond ONLY with the cover letter text, no JSON wrapper.

RESUME:
${resume.slice(0, 3000)}

JOB DESCRIPTION:
${jobDescription.slice(0, 2000)}${companyName ? `\n\nCOMPANY: ${companyName}` : ""}`
      }]
    });

    const coverLetter = message.content[0].text.trim();

    // Track usage
    const db = admin.firestore();
    const month = new Date().toISOString().slice(0, 7);
    await db.doc(`usage/${userId}_${month}`).set(
      { coverLetters: admin.firestore.FieldValue.increment(1), userId, month },
      { merge: true }
    );

    res.status(200).json({ coverLetter });
  } catch (err) {
    console.error("cover-letter error:", err);
    res.status(500).json({ error: err.message });
  }
}, CAPS), { name: "cover-letter" })));
