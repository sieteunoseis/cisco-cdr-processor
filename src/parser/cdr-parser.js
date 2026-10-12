"use strict";

const fs = require("node:fs");
const { parse } = require("csv-parse");
const {
  epochToDate,
  epochToDateNullable,
  intToIp,
  stringToIp,
  secondsToInterval,
  emptyToNull,
  parseInt32,
} = require("./type-converters");

// Columns that are int-to-IP (positional)
const INT_TO_IP_COLS = new Set([7, 13, 21, 28, 35, 43, 85, 91]);

// Columns that are string-to-IP (positional)
const STRING_TO_IP_COLS = new Set([80, 81]);

// Column name map (positional)
const COLUMN_NAMES = [
  "cdrrecordtype", // 0
  "globalcallid_callmanagerid", // 1
  "globalcallid_callid", // 2
  "origlegcallidentifier", // 3
  "datetimeorigination", // 4
  "orignodeid", // 5
  "origspan", // 6
  "origipaddr", // 7
  "callingpartynumber", // 8
  "callingpartyunicodeloginuserid", // 9
  "origcause_location", // 10
  "origcause_value", // 11
  "origprecedencelevel", // 12
  "origmediatransportaddress_ip", // 13
  "origmediatransportaddress_port", // 14
  "origmediacap_payloadcapability", // 15
  "origmediacap_maxframesperpacket", // 16
  "origmediacap_g723bitrate", // 17
  "origvideocap_codec", // 18
  "origvideocap_bandwidth", // 19
  "origvideocap_resolution", // 20
  "origvideotransportaddress_ip", // 21
  "origvideotransportaddress_port", // 22
  "origrsvpaudiostat", // 23
  "origrsvpvideostat", // 24
  "destlegidentifier", // 25
  "destnodeid", // 26
  "destspan", // 27
  "destipaddr", // 28
  "originalcalledpartynumber", // 29
  "finalcalledpartynumber", // 30
  "finalcalledpartyunicodeloginuserid", // 31
  "destcause_location", // 32
  "destcause_value", // 33
  "destprecedencelevel", // 34
  "destmediatransportaddress_ip", // 35
  "destmediatransportaddress_port", // 36
  "destmediacap_payloadcapability", // 37
  "destmediacap_maxframesperpacket", // 38
  "destmediacap_g723bitrate", // 39
  "destvideocap_codec", // 40
  "destvideocap_bandwidth", // 41
  "destvideocap_resolution", // 42
  "destvideotransportaddress_ip", // 43
  "destvideotransportaddress_port", // 44
  "destrsvpaudiostat", // 45
  "destrsvpvideostat", // 46
  "datetimeconnect", // 47
  "datetimedisconnect", // 48
  "lastredirectdn", // 49
  "pkid", // 50
  "originalcalledpartynumberpartition", // 51
  "callingpartynumberpartition", // 52
  "finalcalledpartynumberpartition", // 53
  "lastredirectdnpartition", // 54
  "duration", // 55
  "origdevicename", // 56
  "destdevicename", // 57
  "origcallterminationonbehalfof", // 58
  "destcallterminationonbehalfof", // 59
  "origcalledpartyredirectonbehalfof", // 60
  "lastredirectredirectonbehalfof", // 61
  "origcalledpartyredirectreason", // 62
  "lastredirectredirectreason", // 63
  "destconversationid", // 64
  "globalcallid_clusterid", // 65
  "joinonbehalfof", // 66
  "comment", // 67
  "authcodedescription", // 68
  "authorizationlevel", // 69
  "clientmattercode", // 70
  "origdtmfmethod", // 71
  "destdtmfmethod", // 72
  "callsecuredstatus", // 73
  "origconversationid", // 74
  "origmediacap_bandwidth", // 75
  "destmediacap_bandwidth", // 76
  "authorizationcodevalue", // 77
  "outpulsedcallingpartynumber", // 78
  "outpulsedcalledpartynumber", // 79
  "origipv4v6addr", // 80
  "destipv4v6addr", // 81
  "origvideocap_codec_channel2", // 82
  "origvideocap_bandwidth_channel2", // 83
  "origvideocap_resolution_channel2", // 84
  "origvideotransportaddress_ip_channel2", // 85
  "origvideotransportaddress_port_channel2", // 86
  "origvideochannel_role_channel2", // 87
  "destvideocap_codec_channel2", // 88
  "destvideocap_bandwidth_channel2", // 89
  "destvideocap_resolution_channel2", // 90
  "destvideotransportaddress_ip_channel2", // 91
  "destvideotransportaddress_port_channel2", // 92
  "destvideochannel_role_channel2", // 93
  "incomingprotocolid", // 94
  "incomingprotocolcallref", // 95
  "outgoingprotocolid", // 96
  "outgoingprotocolcallref", // 97
  "currentroutingreason", // 98
  "origroutingreason", // 99
  "lastredirectingroutingreason", // 100
  "huntpilotpartition", // 101
  "huntpilotdn", // 102
  "calledpartypatternusage", // 103
  "incomingicid", // 104
  "incomingorigioi", // 105
  "incomingtermioi", // 106
  "outgoingicid", // 107
  "outgoingorigioi", // 108
  "outgoingtermioi", // 109
  "outpulsedoriginalcalledpartynumber", // 110
  "outpulsedlastredirectingnumber", // 111
  // CUCM 14/15 additional columns
  "wascallqueued", // 112
  "totalwaittimeinqueue", // 113
  "callingpartynumber_uri", // 114
  "originalcalledpartynumber_uri", // 115
  "finalcalledpartynumber_uri", // 116
  "lastredirectdn_uri", // 117
  "mobilecallingpartynumber", // 118
  "finalmobilecalledpartynumber", // 119
  "origmobiledevicename", // 120
  "destmobiledevicename", // 121
  "origmobilecallduration", // 122
  "destmobilecallduration", // 123
  "mobilecalltype", // 124
  "originalcalledpartypattern", // 125
  "finalcalledpartypattern", // 126
  "lastredirectingpartypattern", // 127
  "huntpilotpattern", // 128
  "origdevicetype", // 129
  "destdevicetype", // 130
  "origdevicesessionid", // 131
  "destdevicesessionid", // 132
];

// String columns (emptyToNull applied, no parseInt)
const STRING_COLS = new Set([
  8, 9, 23, 24, 29, 30, 31, 45, 46, 49, 50, 51, 52, 53, 54, 56, 57, 65, 67, 68,
  70, 77, 78, 79, 80, 81, 95, 97, 101, 102, 104, 105, 106, 107, 108, 109, 110,
  111,
  // CUCM 14/15 string columns
  114, 115, 116, 117, 118, 119, 120, 121, 125, 126, 127, 128, 131, 132,
]);

function mapRow(row) {
  const obj = {};
  for (let i = 0; i < COLUMN_NAMES.length; i++) {
    const name = COLUMN_NAMES[i];
    const raw = row[i] !== undefined ? row[i] : "";

    if (i === 4) {
      obj[name] = epochToDate(raw);
    } else if (i === 47) {
      obj[name] = epochToDateNullable(raw);
    } else if (i === 48) {
      obj[name] = epochToDate(raw);
    } else if (i === 55) {
      obj[name] = secondsToInterval(raw);
    } else if (INT_TO_IP_COLS.has(i)) {
      obj[name] = intToIp(raw);
    } else if (STRING_TO_IP_COLS.has(i)) {
      obj[name] = stringToIp(raw);
    } else if (i === 50) {
      // pkid: keep as-is
      obj[name] = raw || null;
    } else if (STRING_COLS.has(i)) {
      obj[name] = emptyToNull(raw);
    } else {
      // integer column
      obj[name] = parseInt32(raw);
    }
  }
  return obj;
}

async function parseCdrFile(filePath) {
  // Auto-detect: CUCM 15 files have 2 header rows (names + types),
  // older files have 1 header row (types only).
  // Peek at first line to decide.
  const firstLine = fs.readFileSync(filePath, "utf8").split("\n")[0];
  const hasNameHeader =
    firstLine.startsWith('"cdrRecordType"') ||
    firstLine.startsWith('"cdrrecordtype"');
  const fromLine = hasNameHeader ? 3 : 2;

  return new Promise((resolve, reject) => {
    const records = [];
    const stream = fs
      .createReadStream(filePath)
      .pipe(parse({ from_line: fromLine, relax_column_count: true }));
    stream.on("data", (row) => records.push(mapRow(row)));
    stream.on("end", () => resolve(records));
    stream.on("error", reject);
  });
}

module.exports = { parseCdrFile };
