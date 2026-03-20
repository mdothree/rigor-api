/**
 * /api/salary/strategy.js
 * Salary negotiation strategy via Claude with market data
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { jobTitle, company, offeredSalary, location, benefits, yearsExp, currentSalary, targetSalary, competing, achievements } = req.body;
  if (!jobTitle || !offeredSalary) return res.status(400).json({ error: "jobTitle and offeredSalary are required" });

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `You are an expert salary negotiation coach. Create a negotiation strategy for this offer.

JOB: ${jobTitle}${company ? ` at ${company}` : ""}
LOCATION: ${location || "US"}
OFFERED: ${offeredSalary}
YEARS EXPERIENCE: ${yearsExp || "not specified"}
CURRENT SALARY: ${currentSalary || "not provided"}
TARGET: ${targetSalary || "not specified"}
COMPETING OFFERS: ${competing || "none"}
ACHIEVEMENTS: ${achievements || "not provided"}
BENEFITS: ${benefits || "not provided"}

Respond ONLY with valid JSON:
{
  "marketLow": <integer annual salary>,
  "marketMid": <integer annual salary>,
  "marketHigh": <integer annual salary>,
  "recommendation": <integer - what to counter with>,
  "assessment": "<1-sentence assessment of the offer vs market>",
  "script": "<exact word-for-word negotiation script to use on the call, 3-5 sentences>",
  "tactics": ["<tactic 1>", "<tactic 2>", "<tactic 3>", "<tactic 4>"],
  "nonSalary": ["<non-salary item to negotiate 1>", "<item 2>", "<item 3>", "<item 4>"],
  "redFlags": ["<any concerning terms to watch for>"]
}`
      }]
    });

    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("salary/strategy error:", err);
    res.status(500).json({ error: err.message });
  }
});
