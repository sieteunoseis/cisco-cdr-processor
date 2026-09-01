-- sql/Migration011_alert_quality.sql
-- quality_degradation: alert if any call in the window crosses a CMR
-- quality threshold (MOS below, or jitter/latency/packet-loss above).
-- Different shape than the rate-based types — one specific metric column,
-- like long_call's "any call over threshold" rather than a % of calls.
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_type_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_type_check
  CHECK (type IN ('volume_spike', 'failure_rate', 'label_volume', 'long_call', 'quality_degradation'));
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS metric VARCHAR(20);
