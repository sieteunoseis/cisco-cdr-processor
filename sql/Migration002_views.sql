-- Migration 002: Create convenience views used by existing team queries
-- These views make the raw CDR/CMR tables easier to query directly in DBeaver/psql

-- Drop all views to allow column changes (safe — views are just queries, no data)
DROP VIEW IF EXISTS cmr_augmented;
DROP VIEW IF EXISTS cdr_augmented;
DROP VIEW IF EXISTS cdr_basic;

-- cdr_basic: Human-readable timestamps, duration, and core call fields
CREATE OR REPLACE VIEW cdr_basic AS
SELECT
    pkid,
    globalcallid_callmanagerid,
    globalcallid_callid,
    globalcallid_clusterid,
    datetimeorigination,
    datetimeconnect,
    datetimedisconnect,
    duration,
    callingpartynumber,
    callingpartynumberpartition,
    originalcalledpartynumber,
    originalcalledpartynumberpartition,
    finalcalledpartynumber,
    finalcalledpartynumberpartition,
    lastredirectdn,
    lastredirectdnpartition,
    origdevicename,
    destdevicename,
    origipaddr,
    origipv4v6addr,
    destipaddr,
    destipv4v6addr,
    origcause_value,
    destcause_value,
    origcallterminationonbehalfof,
    destcallterminationonbehalfof,
    origcalledpartyredirectonbehalfof,
    lastredirectredirectonbehalfof,
    origcalledpartyredirectreason,
    lastredirectredirectreason,
    origlegcallidentifier,
    destlegidentifier,
    destconversationid,
    origconversationid,
    callingpartyunicodeloginuserid,
    finalcalledpartyunicodeloginuserid,
    origmediacap_payloadcapability,
    destmediacap_payloadcapability,
    huntpilotdn,
    huntpilotpartition,
    incomingprotocolid,
    incomingprotocolcallref,
    outgoingprotocolid,
    outgoingprotocolcallref,
    currentroutingreason,
    origdtmfmethod,
    destdtmfmethod,
    callsecuredstatus,
    authcodedescription,
    authorizationcodevalue,
    authorizationlevel,
    clientmattercode,
    comment,
    joinonbehalfof,
    outpulsedcallingpartynumber,
    outpulsedcalledpartynumber,
    -- Enrichment fields
    orig_device_description,
    orig_device_user,
    orig_device_pool,
    orig_device_location,
    orig_device_type,
    orig_device_model,
    dest_device_description,
    dest_device_user,
    dest_device_pool,
    dest_device_location,
    dest_device_type,
    dest_device_model,
    calling_party_user,
    called_party_user,
    route_pattern_matched,
    enriched_at
FROM cdr;

-- cdr_augmented: CDR with lookup table descriptions resolved to text
CREATE OR REPLACE VIEW cdr_augmented AS
SELECT
    c.*,
    oc.description AS origcause,
    dc.description AS destcause,
    obo_orig.description AS origcallterminationonbehalfof_text,
    obo_dest.description AS destcallterminationonbehalfof_text,
    obo_origredirect.description AS origcalledpartyredirectonbehalfof_text,
    obo_lastredirect.description AS lastredirectredirectonbehalfof_text,
    reason_current.description AS currentroutingreason_text,
    reason_orig.description AS origroutingreason_text,
    reason_lastredirect.description AS lastredirectingroutingreason_text,
    codec_orig.description AS origcodec,
    codec_dest.description AS destcodec
FROM cdr c
LEFT JOIN cdr_cause oc ON c.origcause_value = oc.id
LEFT JOIN cdr_cause dc ON c.destcause_value = dc.id
LEFT JOIN cdr_onbehalfof obo_orig ON c.origcallterminationonbehalfof = obo_orig.id
LEFT JOIN cdr_onbehalfof obo_dest ON c.destcallterminationonbehalfof = obo_dest.id
LEFT JOIN cdr_onbehalfof obo_origredirect ON c.origcalledpartyredirectonbehalfof = obo_origredirect.id
LEFT JOIN cdr_onbehalfof obo_lastredirect ON c.lastredirectredirectonbehalfof = obo_lastredirect.id
LEFT JOIN cdr_reason reason_current ON c.currentroutingreason = reason_current.id
LEFT JOIN cdr_reason reason_orig ON c.origroutingreason = reason_orig.id
LEFT JOIN cdr_reason reason_lastredirect ON c.lastredirectingroutingreason = reason_lastredirect.id
LEFT JOIN cdr_codec codec_orig ON c.origmediacap_payloadcapability = codec_orig.id
LEFT JOIN cdr_codec codec_dest ON c.destmediacap_payloadcapability = codec_dest.id;

-- cmr_augmented: CMR with device names and call info joined from CDR
CREATE OR REPLACE VIEW cmr_augmented AS
SELECT
    m.*,
    m.devicename AS localdevicename,
    c.callingpartynumber,
    c.finalcalledpartynumber,
    c.origdevicename,
    c.destdevicename,
    CASE
        WHEN m.devicename = c.origdevicename THEN c.destdevicename
        WHEN m.devicename = c.destdevicename THEN c.origdevicename
        ELSE NULL
    END AS remotedevicename,
    c.datetimeorigination,
    c.duration AS callduration
FROM cmr m
LEFT JOIN cdr c ON m.globalcallid_callmanagerid = c.globalcallid_callmanagerid
    AND m.globalcallid_callid = c.globalcallid_callid;
