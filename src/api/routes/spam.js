const express = require("express");
const twilio = require("twilio");
const config = require("../../config");

// Twilio Lookup v1 + the Nomorobo Spam Score add-on is what actually offers
// spam/robocall detection — Lookup v2's own field set (caller_name,
// line_type_intelligence, etc.) has no such signal. Only NANP (US/Canada)
// numbers are supported here since that's this deployment's entire dataset.
function toE164(number) {
  const digits = String(number).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function createSpamRouter() {
  const router = express.Router();

  router.post("/check", async (req, res) => {
    const { number } = req.body || {};
    if (typeof number !== "string" || !number.trim()) {
      return res.status(400).json({ error: "number is required" });
    }

    const e164 = toE164(number);
    if (!e164) {
      return res.status(400).json({
        error:
          "number must be a 10-digit NANP number (or 11 digits starting with 1)",
      });
    }

    const { accountSid, apiKeySid, apiKeySecret } = config.twilio;
    if (!accountSid || !apiKeySid || !apiKeySecret) {
      return res.status(503).json({ error: "Twilio is not configured" });
    }

    try {
      // API Key auth (not the main Account SID + Auth Token) — Twilio's
      // recommended credential type for a service integration like this,
      // since the key can be individually revoked without rotating the
      // account's master Auth Token.
      const client = twilio(apiKeySid, apiKeySecret, { accountSid });
      const lookup = await client.lookups.v1
        .phoneNumbers(e164)
        .fetch({ addOns: ["nomorobo_spamscore"] });

      // Per Twilio's documented add-on response shape:
      // { addOns: { results: { nomorobo_spamscore: { status, result: { score } } } } }
      // score is 0 (legitimate) or 1 (spam/robocall). This is best-effort
      // from Twilio's own docs/examples — not yet verified against a live
      // response (no credentials were available while building this). If
      // this route starts erroring in practice, log a raw lookup.addOns and
      // adjust the path below to match.
      const addOn = lookup.addOns?.results?.nomorobo_spamscore;
      if (!addOn || addOn.status !== "successful") {
        console.error(
          "Nomorobo add-on did not return successfully:",
          JSON.stringify(addOn),
        );
        return res
          .status(502)
          .json({ error: "Spam check did not return a result" });
      }

      const score = addOn.result?.score;
      if (score !== 0 && score !== 1) {
        console.error(
          "Unexpected Nomorobo spam score shape:",
          JSON.stringify(addOn.result),
        );
        return res
          .status(502)
          .json({ error: "Spam check returned an unexpected result" });
      }

      res.json({ isSpam: score === 1 });
    } catch (err) {
      console.error("Twilio spam check failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSpamRouter };
