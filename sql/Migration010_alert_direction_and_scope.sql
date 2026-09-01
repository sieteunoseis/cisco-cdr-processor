-- sql/Migration010_alert_direction_and_scope.sql
-- direction: whether a threshold-comparison rule (volume_spike,
-- label_volume) alerts when the value goes above the threshold (existing
-- default behavior) or drops below it — e.g. a recording-volume
-- label_volume rule set to "below" catches recording silently stopping,
-- not just spiking. Ignored by failure_rate/long_call, which only make
-- sense in one direction.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'above' CHECK (direction IN ('above', 'below'));

-- label_id (added in Migration009 for label_volume, where it's required)
-- is now also an optional scope for volume_spike/failure_rate — when set,
-- those rules only look at calls matching the label instead of the whole
-- org. No schema change needed, just relaxed application-layer validation.
