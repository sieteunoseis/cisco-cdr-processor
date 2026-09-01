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

// Short names accepted in TWILIO_SPAM_PROVIDER, resolved to Twilio's actual
// add-on unique_name before it goes in the addOns array.
const PROVIDER_ALIASES = {
  nomorobo: "nomorobo_spamscore",
  scout: "icehook_scout",
};

function resolveProviderName(name) {
  return PROVIDER_ALIASES[name] || name;
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
    // Pass through the entire raw Scout result (carrier, line type, porting,
    // geo/LATA/OCN data, etc.) rather than cherry-picking fields — the UI
    // shows all of it, and this way new Scout fields show up automatically.
    return {
      isSpam: rating === "likely" || rating === "highly_likely",
      ...result,
    };
  }
  return null;
}

function createSpamRouter(pool) {
  const router = express.Router();

  // Batch cache lookup so the UI can hide "Check Spam" buttons for numbers
  // already checked (avoids burning add-on credits on repeat checks) and
  // show the persisted per-provider detail. Keyed by the *raw* input string
  // the caller sent, not the normalized E.164 form, so the frontend doesn't
  // need to duplicate toE164() to match up results.
  router.get("/checked", async (req, res) => {
    const raw = req.query.numbers;
    if (typeof raw !== "string" || !raw.trim()) {
      return res.json({ results: {} });
    }

    const e164ByInput = new Map();
    for (const input of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const e164 = toE164(input);
      if (e164) e164ByInput.set(input, e164);
    }
    if (e164ByInput.size === 0) {
      return res.json({ results: {} });
    }

    try {
      const e164List = [...new Set(e164ByInput.values())];
      const dbResult = await pool.query(
        "SELECT number, is_spam, providers, checked_at FROM spam_checks WHERE number = ANY($1)",
        [e164List],
      );
      const byE164 = new Map(dbResult.rows.map((row) => [row.number, row]));

      const results = {};
      for (const [input, e164] of e164ByInput) {
        const row = byE164.get(e164);
        if (row) {
          results[input] = {
            isSpam: row.is_spam,
            providers: row.providers,
            checkedAt: row.checked_at,
          };
        }
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

    const providers = config.twilio.spamProviders.map(resolveProviderName);

    try {
      // API Key auth (not the main Account SID + Auth Token) — Twilio's
      // recommended credential type for a service integration like this,
      // since the key can be individually revoked without rotating the
      // account's master Auth Token.
      const client = twilio(apiKeySid, apiKeySecret, { accountSid });
      const lookup = await client.lookups.v1
        .phoneNumbers(e164)
        .fetch({ addOns: providers });

      const providerResults = {};
      let isSpam = false;

      for (const provider of providers) {
        const addOn = lookup.addOns?.results?.[provider];
        if (!addOn || addOn.status !== "successful") {
          console.error(
            `${provider} add-on did not return successfully:`,
            JSON.stringify(addOn),
          );
          providerResults[provider] = { error: "no result" };
          continue;
        }

        const interpreted = interpretSpamResult(provider, addOn.result);
        if (!interpreted) {
          console.error(
            `Unexpected ${provider} result shape:`,
            JSON.stringify(addOn.result),
          );
          providerResults[provider] = { error: "unexpected result shape" };
          continue;
        }

        providerResults[provider] = interpreted;
        if (interpreted.isSpam) isSpam = true;
      }

      if (Object.values(providerResults).every((r) => r.error)) {
        return res
          .status(502)
          .json({ error: "Spam check did not return a result" });
      }

      try {
        await pool.query(
          `INSERT INTO spam_checks (number, is_spam, providers, checked_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (number) DO UPDATE
             SET is_spam = $2, providers = $3, checked_at = NOW()`,
          [e164, isSpam, JSON.stringify(providerResults)],
        );
      } catch (cacheErr) {
        // Don't fail the check just because the cache write failed — the
        // caller still gets a real result, just won't be remembered.
        console.error("Failed to cache spam check result:", cacheErr.message);
      }

      // isSpam stays top-level (any provider flags it = spam) so existing
      // callers that only read res.isSpam keep working unchanged; the
      // per-provider detail (Scout's carrier data included) is additive.
      res.json({ isSpam, providers: providerResults });
    } catch (err) {
      console.error("Twilio spam check failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSpamRouter };
