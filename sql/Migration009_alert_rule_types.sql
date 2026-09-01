-- sql/Migration009_alert_rule_types.sql
-- Adds two rule types: label_volume (alert on call volume matching an
-- existing label — reuses label_rules for International/Toll/N11-style
-- abuse patterns instead of hardcoding pattern logic here) and long_call
-- (per-call duration threshold, a different shape than the rate-based
-- types).
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_type_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_type_check
  CHECK (type IN ('volume_spike', 'failure_rate', 'label_volume', 'long_call'));
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES label_rules(id) ON DELETE CASCADE;
