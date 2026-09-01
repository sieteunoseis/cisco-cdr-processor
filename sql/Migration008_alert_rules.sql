-- sql/Migration008_alert_rules.sql
-- Rule-based anomaly detection: volume spikes and failure-rate thresholds,
-- evaluated on demand against live CDR data (no background poller).
CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('volume_spike', 'failure_rate')),
  lookback VARCHAR(10) NOT NULL,
  threshold NUMERIC NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
