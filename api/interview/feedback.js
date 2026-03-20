/**
 * /api/interview/feedback.js
 * Score and give feedback on an interview answer via Claude
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question, answer, role = "" } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "question and answer are required" });

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are an expert interview coach. Evaluate this ${role} interview answer.

QUESTION: ${question}
ANSWER: ${answer}

Respond ONLY with valid JSON:
{
  "score": <integer 0-100>,
  "summary": "<one sentence overall verdict>",
  "positive": "<what worked well, 1-2 sentences>",
  "improve": "<most important thing to improve, 1-2 sentences>",
  "example": "<a better opening or structure suggestion, 1-2 sentences>"
}`
      }]
    });

    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("interview/feedback error:", err);
    res.status(500).json({ error: err.message });
  }
});
