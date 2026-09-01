const express = require("express");
const twilio = require("twilio");
const config = require("../../config");

// Twilio Lookup v1 + a marketplace add-on is what actually offers
// spam/robocall detection — Lookup v2's own field set (caller_name,
// line_type_intelligence, etc.) has no such signal. Only NANP (US/Canada)
// numbers are supported here since that's this deployment's entire dataset.
function toE164(number) {
  const digits = String(number).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// Each provider shapes its add-on result differently. Nomorobo is a binary
// score; Scout is a graded risk score + categorical tier — "likely" and
// "highly_likely" both count as spam here.
function interpretSpamResult(provider, result) {
  if (provider === "nomorobo_spamscore") {
    const score = result?.score;
    if (score !== 0 && score !== 1) return null;
    return { isSpam: score === 1 };
  }
  if (provider === "icehook_scout") {
    const rating = result?.risk_rating;
    if (typeof rating !== "string") return null;
    return {
      isSpam: rating === "likely" || rating === "highly_likely",
      riskLevel: result.risk_level,
      riskRating: rating,
      // Carrier/line data Scout bundles into the same call — useful for
      // troubleshooting (e.g. "this DID is actually a CenturyLink line,
      // not ours") without a separate carrier-lookup add-on.
      carrier: result.operating_company_name ?? null,
      lineType: result.line_type ?? null,
      ported: result.ported ?? null,
    };
  }
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

    const provider = config.twilio.spamProvider;

    try {
      // API Key auth (not the main Account SID + Auth Token) — Twilio's
      // recommended credential type for a service integration like this,
      // since the key can be individually revoked without rotating the
      // account's master Auth Token.
      const client = twilio(apiKeySid, apiKeySecret, { accountSid });
      const lookup = await client.lookups.v1
        .phoneNumbers(e164)
        .fetch({ addOns: [provider] });

      const addOn = lookup.addOns?.results?.[provider];
      if (!addOn || addOn.status !== "successful") {
        console.error(
          `${provider} add-on did not return successfully:`,
          JSON.stringify(addOn),
        );
        return res
          .status(502)
          .json({ error: "Spam check did not return a result" });
      }

      const interpreted = interpretSpamResult(provider, addOn.result);
      if (!interpreted) {
        console.error(
          `Unexpected ${provider} result shape:`,
          JSON.stringify(addOn.result),
        );
        return res
          .status(502)
          .json({ error: "Spam check returned an unexpected result" });
      }

      res.json(interpreted);
    } catch (err) {
      console.error("Twilio spam check failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSpamRouter };
