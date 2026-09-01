-- sql/Migration006_spam_checks.sql
-- Cache of spam-check results, keyed by E.164 number. Lets the UI hide the
-- "Check Spam" button once a number has already been checked (avoids
-- burning Twilio add-on credits on repeat checks) and persists the
-- per-provider detail (e.g. Scout's carrier/risk data) for later display.
CREATE TABLE IF NOT EXISTS spam_checks (
  number VARCHAR(20) PRIMARY KEY,
  is_spam BOOLEAN NOT NULL,
  providers JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
