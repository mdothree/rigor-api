/**
 * /api/networking/email.js
 */
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("../_middleware/auth");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EMAIL_TYPES = {
  "cold-outreach":  "a professional cold outreach",
  "coffee-chat":    "a warm coffee chat request",
  "referral":       "a referral ask",
  "follow-up":      "a follow-up after meeting or applying",
  "thank-you":      "a thank-you note after an interview",
  "reconnect":      "a reconnection message after time apart",
};

module.exports = requireAuth(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { emailType, recipientName, recipientTitle, recipientCompany, connectionPoint, yourName, yourRole, yourGoal, context } = req.body;
  if (!recipientName) return res.status(400).json({ error: "recipientName is required" });
  try {
    const typeDesc = EMAIL_TYPES[emailType] || "a professional networking email";
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Write ${typeDesc} email.
TO: ${recipientName}${recipientTitle ? `, ${recipientTitle}` : ""}${recipientCompany ? ` at ${recipientCompany}` : ""}
FROM: ${yourName || "[Your Name]"}${yourRole ? `, ${yourRole}` : ""}
CONNECTION: ${connectionPoint || "LinkedIn / professional network"}
GOAL: ${yourGoal || "connect and learn"}
${context ? `CONTEXT: ${context}` : ""}

Rules: Under 150 words. Specific and genuine. No generic phrases. Natural tone.

Respond ONLY with valid JSON:
{ "subject": "<compelling subject line>", "body": "<email body text only, no subject line>" }`
      }]
    });
    const text = message.content[0].text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
