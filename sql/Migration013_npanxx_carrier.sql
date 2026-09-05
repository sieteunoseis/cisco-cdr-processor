-- Migration 013: NPA-NXX carrier lookup table + CDR carrier columns
-- Idempotent — safe to run on every startup
--
-- npanxx is a local mirror of NANPA's public Central Office Code
-- Assignment report (https://www.nanpa.com/reports/co-code-reports/cocodes_assign),
-- refreshed periodically by npanxx-importer.js. It reflects the carrier an
-- NPA-NXX block was assigned to, not live LNP porting of an individual number.

CREATE TABLE IF NOT EXISTS npanxx (
    prefix text PRIMARY KEY,
    state text,
    rate_center text,
    company text,
    ocn text,
    assignment_date date,
    updated_at timestamp NOT NULL
);

ALTER TABLE cdr ADD COLUMN IF NOT EXISTS callingpartynumber_carrier text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS originalcalledpartynumber_carrier text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS finalcalledpartynumber_carrier text;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS lastredirectdn_carrier text;

-- Redefine cdr_basic (originally created in Migration002_views.sql) to
-- surface the new carrier columns. Runs after the ADD COLUMNs above so it
-- works on a fresh install too, where Migration002 runs before this file.
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
    enriched_at,
    callingpartynumber_carrier,
    originalcalledpartynumber_carrier,
    finalcalledpartynumber_carrier,
    lastredirectdn_carrier
FROM cdr;
