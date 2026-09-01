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

-- Sample rules for reference — left disabled so a generic threshold never
-- starts firing against real production volume without being tuned first.
INSERT INTO alert_rules (name, type, lookback, threshold, enabled)
SELECT * FROM (VALUES
  ('Hourly volume spike', 'volume_spike', '1h', 2, false),
  ('High failure rate', 'failure_rate', '1h', 20, false)
) AS defaults(name, type, lookback, threshold, enabled)
WHERE NOT EXISTS (SELECT 1 FROM alert_rules);
