"use strict";

const fs = require("node:fs");
const { parse } = require("csv-parse");
const {
  epochToDate,
  emptyToNull,
  parseInt32,
  parseVarVQMetrics,
} = require("./type-converters");

// Column name map (positional, 0-47 for CUCM 15)
const COLUMN_NAMES = [
  "cdrrecordtype", // 0
  "globalcallid_callmanagerid", // 1
  "globalcallid_callid", // 2
  "nodeid", // 3
  "directorynum", // 4
  "callidentifier", // 5
  "datetimestamp", // 6
  "numberpacketssent", // 7
  "numberoctetssent", // 8
  "numberpacketsreceived", // 9
  "numberoctetsreceived", // 10
  "numberpacketslost", // 11
  "jitter", // 12
  "latency", // 13
  "pkid", // 14
  "directorynumpartition", // 15
  "globalcallid_clusterid", // 16
  "devicename", // 17
  "varvqmetrics", // 18
  // CUCM 14/15 additional columns
  "duration", // 19
  "videocontenttype", // 20
  "videoduration", // 21
  "numbervideopacketssent", // 22
  "numbervideooctetssent", // 23
  "numbervideopacketsreceived", // 24
  "numbervideooctetsreceived", // 25
  "numbervideopacketslost", // 26
  "videoaveragejitter", // 27
  "videoroundtriptime", // 28
  "videoonewaydelay", // 29
  "videoreceptionmetrics", // 30
  "videotransmissionmetrics", // 31
  "videocontenttype_channel2", // 32
  "videoduration_channel2", // 33
  "numbervideopacketssent_channel2", // 34
  "numbervideooctetssent_channel2", // 35
  "numbervideopacketsreceived_channel2", // 36
  "numbervideooctetsreceived_channel2", // 37
  "numbervideopacketslost_channel2", // 38
  "videoaveragejitter_channel2", // 39
  "videoroundtriptime_channel2", // 40
  "videoonewaydelay_channel2", // 41
  "videoreceptionmetrics_channel2", // 42
  "videotransmissionmetrics_channel2", // 43
  "localsessionid", // 44
  "remotesessionid", // 45
  "headsetsn", // 46
  "headsetmetrics", // 47
];

// String columns (emptyToNull applied)
const STRING_COLS = new Set([
  4, 14, 15, 16, 17, 20, 30, 31, 32, 42, 43, 44, 45, 46, 47,
]);

// VarVQMetrics field-to-DB-column mapping
const VQ_MAP = {
  MLQK: "moslqk",
  MLQKav: "moslqkavg",
  MLQKmn: "moslqkmin",
  MLQKmx: "moslqkmax",
  ICR: "intervalconcealratio",
  CCR: "cumulativeconcealratio",
  ICRmx: "intervalconcealratiomax",
  CS: "concealsecs",
  SCS: "severelyconcealsecs",
};

function mapRow(row) {
  const obj = {};
  const colCount = Math.min(row.length, COLUMN_NAMES.length);
  for (let i = 0; i < colCount; i++) {
    const name = COLUMN_NAMES[i];
    const raw = row[i] !== undefined ? row[i] : "";

    if (i === 6) {
      obj[name] = epochToDate(raw);
    } else if (i === 14) {
      // pkid: keep as-is
      obj[name] = raw || null;
    } else if (i === 18) {
      // varvqmetrics: parse into separate fields, do not store raw
      const parsed = parseVarVQMetrics(raw);
      for (const [vqKey, dbCol] of Object.entries(VQ_MAP)) {
        obj[dbCol] = parsed[vqKey] !== undefined ? parsed[vqKey] : null;
      }
    } else if (STRING_COLS.has(i)) {
      obj[name] = emptyToNull(raw);
    } else {
      obj[name] = parseInt32(raw);
    }
  }
  return obj;
}

async function parseCmrFile(filePath) {
  // Auto-detect: CUCM 15 files have 2 header rows (names + types),
  // older files have 1 header row (types only).
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

module.exports = { parseCmrFile };
