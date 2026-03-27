-- Starred/flagged calls for quick access
CREATE TABLE IF NOT EXISTS starred_calls (
  id SERIAL PRIMARY KEY,
  globalcallid_callid INTEGER NOT NULL,
  globalcallid_callmanagerid INTEGER NOT NULL,
  note TEXT DEFAULT '',
  starred_by VARCHAR(100) DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(globalcallid_callid, globalcallid_callmanagerid)
);

CREATE INDEX IF NOT EXISTS idx_starred_calls_created ON starred_calls(created_at DESC);
