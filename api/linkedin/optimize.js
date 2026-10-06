/**
 * /api/linkedin/optimize.js
 * LinkedIn profile optimization via Claude
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const { withCors } = require("../_middleware/cors");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = withCors(requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { headline, about, experience, skills, targetRole, targetIndustry, targetJD } = req.body;
  if (!headline && !about) return res.status(400).json({ error: "At least headline or about is required" });

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `You are a LinkedIn optimization expert. Rewrite these LinkedIn sections to maximize recruiter visibility and search ranking for a ${targetRole || "professional"} in ${targetIndustry || "their field"}.

CURRENT HEADLINE: ${headline || "Not provided"}
CURRENT ABOUT: ${about || "Not provided"}
CURRENT EXPERIENCE: ${experience || "Not provided"}
SKILLS: ${skills || "Not provided"}
${targetJD ? `TARGET JD: ${targetJD.slice(0, 500)}` : ""}

Respond ONLY with valid JSON:
{
  "optimizedHeadline": "<new headline under 220 chars, keyword-rich>",
  "optimizedAbout": "<new about section, 200-250 words, first-person, compelling>",
  "optimizedExperience": "<rewritten bullet points for most recent role, 3-5 bullets>",
  "recommendedSkills": ["<skill1>", "<skill2>", "<skill3>", "<skill4>", "<skill5>"],
  "keywordGaps": ["<keyword not in current profile but important for target role>"],
  "profileScore": <integer 0-100>,
  "topTip": "<single most impactful improvement>"
}`
      }]
    });

    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json({ optimized: JSON.parse(text) });
  } catch (err) {
    console.error("linkedin/optimize error:", err);
    res.status(500).json({ error: err.message });
  }
}));
