-- sql/Migration005_label_rules.sql
-- Shared CDR label rules (badge classification), replacing the previous
-- per-browser localStorage storage. One global rule set, no per-user scoping.
CREATE TABLE IF NOT EXISTS label_rules (
  id SERIAL PRIMARY KEY,
  label VARCHAR(200) NOT NULL,
  color VARCHAR(20) NOT NULL,
  fields JSONB NOT NULL,
  pattern TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_label_rules_enabled ON label_rules(enabled);

INSERT INTO label_rules (label, color, fields, pattern, enabled)
SELECT * FROM (VALUES
  ('Analog', 'yellow', '["origDevice","destDevice"]'::jsonb, '^(ATA|AN[0-9A-F])', true),
  ('Emergency', 'red', '["called"]'::jsonb, '^(911|112|999|000|111)$', true),
  ('Recording', 'gray', '["calling","called","origDevice","destDevice"]'::jsonb, '^b\d{5,}|Inform|Record|BIB', true),
  ('Phone Device', 'blue', '["origDevice","destDevice"]'::jsonb, '^(SEP|AN[A-F0-9]|JBR|TCT|BOT|CSF)', true)
) AS defaults(label, color, fields, pattern, enabled)
WHERE NOT EXISTS (SELECT 1 FROM label_rules);
