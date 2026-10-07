/**
 * /api/interview/questions.js
 * Generate role-specific interview questions via Claude
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");
const { withRateLimit, withInputCaps } = require("../_middleware/limits");
const { withQuota } = require("../lib/quota");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Server-side length caps (truncate) mirror the client limits.
const CAPS = { role: 200, company: 200, type: 40, resume: 500 };
// Server-side monthly quota (lib/quota.js): reserved before the model call, released on error.
const QUOTA = { counter: "analyses", toolCounter: "interviewSessions" };

module.exports = withCors(requireAuth(withRateLimit(withInputCaps(withQuota(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { role, company, type = "behavioral", resume = "" } = req.body;
  if (!role) return res.status(400).json({ error: "role is required" });

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `Generate 10 ${type} interview questions for a ${role} role${company ? ` at ${company}` : ""}.
${resume ? `Candidate background: ${resume.slice(0, 500)}` : ""}

Respond ONLY with valid JSON:
{
  "questions": [
    { "text": "question text", "type": "Behavioral|Technical|Case|Situational", "tip": "brief coaching tip" }
  ]
}`
      }]
    });

    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("interview/questions error:", err);
    res.status(500).json({ error: err.message });
  }
}, QUOTA), CAPS), { name: "interview-questions" })));
