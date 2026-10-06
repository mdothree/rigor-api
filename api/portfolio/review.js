/**
 * /api/portfolio/review.js
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = withCors(requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { portfolioUrl, portfolioDesc, targetRole, targetCompany, careerStage } = req.body;
  if (!portfolioDesc && !portfolioUrl) return res.status(400).json({ error: "Portfolio description or URL required" });
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: `Review this portfolio for a ${targetRole || "developer"} targeting ${targetCompany || "companies"} at ${careerStage || "mid"} level.

PORTFOLIO: ${portfolioDesc || portfolioUrl}

Respond ONLY with valid JSON:
{
  "overall": <integer 0-100>,
  "categories": [
    { "name": "Technical Depth", "score": <0-100>, "feedback": "<1-2 sentences>" },
    { "name": "Presentation Quality", "score": <0-100>, "feedback": "<1-2 sentences>" },
    { "name": "Business Impact", "score": <0-100>, "feedback": "<1-2 sentences>" },
    { "name": "Relevance to Role", "score": <0-100>, "feedback": "<1-2 sentences>" }
  ],
  "topFixes": ["<fix 1>", "<fix 2>", "<fix 3>", "<fix 4>"],
  "strengths": ["<strength 1>", "<strength 2>"],
  "verdict": "<one honest sentence summary>"
}`
      }]
    });
    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));
