/**
 * /api/interview/questions.js
 * Generate role-specific interview questions via Claude
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = withCors(requireAuth(async (req, res) => {
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
}));
