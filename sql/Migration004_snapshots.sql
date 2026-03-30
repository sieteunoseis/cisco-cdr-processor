-- Call data snapshots: pointers to files on disk
CREATE TABLE IF NOT EXISTS call_snapshots (
  id SERIAL PRIMARY KEY,
  globalcallid_callid BIGINT NOT NULL,
  globalcallid_callmanagerid INTEGER NOT NULL,
  type VARCHAR(32) NOT NULL, -- sip-trace, syslog, network, config, status
  device_name VARCHAR(128), -- NULL for SIP traces, device name for phone data
  file_path VARCHAR(512) NOT NULL, -- relative to /data/snapshots/
  file_size BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (globalcallid_callid, globalcallid_callmanagerid, type, device_name)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_call
  ON call_snapshots (globalcallid_callid, globalcallid_callmanagerid);
