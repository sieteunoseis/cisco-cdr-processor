-- Migration 001: Add enrichment columns, new tables, and indexes
-- Idempotent — safe to run on every startup

-- CUCM 14/15 additional CDR columns (not in original C# schema)
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS wascallqueued integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS totalwaittimeinqueue integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS callingpartynumber_uri text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS originalcalledpartynumber_uri text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS finalcalledpartynumber_uri text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS lastredirectdn_uri text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS mobilecallingpartynumber text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS finalmobilecalledpartynumber text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS origmobiledevicename text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS destmobiledevicename text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS origmobilecallduration integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS destmobilecallduration integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS mobilecalltype integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS originalcalledpartypattern text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS finalcalledpartypattern text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS lastredirectingpartypattern text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS huntpilotpattern text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS origdevicetype integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS destdevicetype integer;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS origdevicesessionid text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS destdevicesessionid text;

-- CUCM 14/15 additional CMR columns
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS duration integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videocontenttype text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoduration integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketssent integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideooctetssent integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketsreceived integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideooctetsreceived integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketslost integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoaveragejitter integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoroundtriptime integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoonewaydelay integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoreceptionmetrics text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videotransmissionmetrics text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videocontenttype_channel2 text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoduration_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketssent_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideooctetssent_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketsreceived_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideooctetsreceived_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS numbervideopacketslost_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoaveragejitter_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoroundtriptime_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoonewaydelay_channel2 integer;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videoreceptionmetrics_channel2 text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS videotransmissionmetrics_channel2 text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS localsessionid text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS remotesessionid text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS headsetsn text;
ALTER TABLE cmr ADD COLUMN IF NOT EXISTS headsetmetrics text;

-- Enrichment columns on cdr table
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_description text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_user text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_pool text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_location text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_description text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_user text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_pool text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_location text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS calling_party_user text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS called_party_user text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_type text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS orig_device_model text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_type text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dest_device_model text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS route_pattern_matched text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS enriched_at timestamp;

-- Enrichment cache table
CREATE TABLE IF NOT EXISTS enrichment_cache (
    cache_key text PRIMARY KEY,
    cache_type text NOT NULL,
    data jsonb NOT NULL,
    fetched_at timestamp NOT NULL,
    expires_at timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrichment_cache_type ON enrichment_cache(cache_type);
CREATE INDEX IF NOT EXISTS idx_enrichment_cache_expires ON enrichment_cache(expires_at);

-- File processing log
CREATE TABLE IF NOT EXISTS file_processing_log (
    filename text PRIMARY KEY,
    file_type text NOT NULL,
    cluster text,
    node text,
    file_date text,
    sequence text,
    records_inserted integer,
    processed_at timestamp NOT NULL,
    processing_time_ms integer,
    error text
);

-- Performance indexes on cdr
CREATE INDEX IF NOT EXISTS idx_cdr_datetimeorigination ON cdr(datetimeorigination);
CREATE INDEX IF NOT EXISTS idx_cdr_callingpartynumber ON cdr(callingpartynumber);
CREATE INDEX IF NOT EXISTS idx_cdr_finalcalledpartynumber ON cdr(finalcalledpartynumber);
CREATE INDEX IF NOT EXISTS idx_cdr_origdevicename ON cdr(origdevicename);
CREATE INDEX IF NOT EXISTS idx_cdr_destdevicename ON cdr(destdevicename);
CREATE INDEX IF NOT EXISTS idx_cdr_globalcallid ON cdr(globalcallid_callmanagerid, globalcallid_callid);
CREATE INDEX IF NOT EXISTS idx_cdr_origcause_value ON cdr(origcause_value);
CREATE INDEX IF NOT EXISTS idx_cdr_destcause_value ON cdr(destcause_value);

-- Performance indexes on cmr
CREATE INDEX IF NOT EXISTS idx_cmr_globalcallid ON cmr(globalcallid_callmanagerid, globalcallid_callid);
CREATE INDEX IF NOT EXISTS idx_cmr_devicename ON cmr(devicename);
CREATE INDEX IF NOT EXISTS idx_cmr_datetimestamp ON cmr(datetimestamp);
