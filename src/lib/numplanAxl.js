// src/lib/numplanAxl.js
// AXL queries against CUCM's numplan table, shared between the
// /api/v1/numplan HTTP route and the numplan_find_available MCP tool.
const axlService = require("cisco-axl");

// Which of `numbers` are configured as real directory numbers (tkpatternusage
// = 2), keyed by number -> description. Every value in `numbers` must
// already be validated as digits-only by the caller (see resolvePatternRange
// in ./patternRange.js) — this function does no escaping of its own.
async function queryConfiguredNumbers(cluster, numbers) {
  if (numbers.length === 0) return new Map();
  const quoted = numbers.map((n) => `'${n}'`).join(",");
  const service = new axlService(
    cluster.host,
    cluster.username,
    cluster.password,
    cluster.version,
  );
  const sql = `SELECT dnorpattern, description FROM numplan WHERE dnorpattern IN (${quoted}) AND tkpatternusage = 2`;
  const response = await service.executeSqlQuery(sql);
  const raw = Array.isArray(response) ? response : response?.row || [];
  const rows = Array.isArray(raw) ? raw : [raw];
  const found = new Map();
  for (const row of rows) {
    found.set(
      row.dnorpattern,
      typeof row.description === "string" ? row.description : null,
    );
  }
  return found;
}

// Devices a directory number is assigned to (a DN can be a shared line
// across multiple devices — a desk phone plus Jabber desktop/mobile, for
// instance — so this is always an array, never a single device). `number`
// must already be validated as digits-only by the caller.
async function queryDevicesForNumber(cluster, number) {
  const service = new axlService(
    cluster.host,
    cluster.username,
    cluster.password,
    cluster.version,
  );
  const sql = `SELECT d.name, d.description, d.pkid FROM numplan dm
    JOIN devicenumplanmap dnm ON dnm.fknumplan = dm.pkid
    JOIN device d ON d.pkid = dnm.fkdevice
    WHERE dm.dnorpattern = '${number}' AND dm.tkpatternusage = 2`;
  const response = await service.executeSqlQuery(sql);
  const raw = Array.isArray(response) ? response : response?.row || [];
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((row) => ({
    name: row.name,
    description: typeof row.description === "string" ? row.description : null,
    // CUCM admin's phoneEdit.do expects the bare UUID, no braces.
    adminUrl: row.pkid
      ? `https://${cluster.host}:8443/ccmadmin/phoneEdit.do?key=${row.pkid.replace(/[{}]/g, "")}`
      : null,
  }));
}

module.exports = { queryConfiguredNumbers, queryDevicesForNumber };
