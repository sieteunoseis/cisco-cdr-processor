const express = require("express");
const { selectLogFiles, getOneFile } = require("cisco-dime");

// Cisco DIME expects dates as "MM/DD/YY HH:MM AM/PM" in the target timezone
// Convert UTC Date to formatted string in America/Los_Angeles
function toCiscoDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("month")}/${get("day")}/${get("year")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

const CISCO_TZ = "Client: (GMT-7:0)America/Los_Angeles";
const axlService = require("cisco-axl");
const { parseSdlTrace } = require("../../parser/sdl-parser");
const config = require("../../config");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { SNAPSHOT_DIR } = require("./snapshots");

function findClusterConfig(clusterId) {
  if (!config.axl.clusters || !config.axl.clusters.length || !clusterId) {
    return null;
  }
  return config.axl.clusters.find((c) => c.clusterId === clusterId) || null;
}

// Cache processnode list per cluster (nodeid -> hostname)
const nodeCache = new Map();

async function resolveNodeHost(clusterConfig, callManagerId) {
  if (!callManagerId) return clusterConfig.host;

  const cacheKey = clusterConfig.clusterId;
  if (!nodeCache.has(cacheKey)) {
    try {
      const service = new axlService(
        clusterConfig.host,
        clusterConfig.username,
        clusterConfig.password,
        clusterConfig.version,
      );
      const response = await service.executeSqlQuery(
        "SELECT pn.name, cm.ctiid FROM callmanager cm JOIN processnode pn ON cm.fkprocessnode = pn.pkid",
      );
      const rows = Array.isArray(response) ? response : response?.row || [];
      const map = new Map();
      for (const row of rows) {
        map.set(String(row.ctiid), row.name);
      }
      nodeCache.set(cacheKey, map);
      console.log(
        `DIME node cache: ${map.size} nodes for cluster "${cacheKey}"`,
      );
    } catch (err) {
      console.warn("Failed to resolve cluster nodes:", err.message);
      return clusterConfig.host;
    }
  }

  const nodes = nodeCache.get(cacheKey);
  return nodes?.get(String(callManagerId)) || clusterConfig.host;
}

async function getAllNodes(clusterConfig) {
  // Ensure node cache is populated
  await resolveNodeHost(clusterConfig, "1");
  const nodes = nodeCache.get(clusterConfig.clusterId);
  return nodes ? [...nodes.values()] : [clusterConfig.host];
}

async function lookupCallContext(pool, callId, callManagerId) {
  const conditions = ["globalcallid_callid = $1"];
  const values = [callId];
  if (callManagerId) {
    conditions.push("globalcallid_callmanagerid = $2");
    values.push(callManagerId);
  }

  const result = await pool.query(
    `SELECT globalcallid_clusterid, globalcallid_callmanagerid,
            callingpartynumber, finalcalledpartynumber,
            originalcalledpartynumber, datetimeorigination, datetimedisconnect
     FROM cdr WHERE ${conditions.join(" AND ")}
     ORDER BY datetimeorigination ASC`,
    values,
  );

  if (result.rows.length === 0) return null;

  const origTimes = result.rows
    .map((r) => new Date(r.datetimeorigination).getTime())
    .filter(Boolean);
  const discTimes = result.rows
    .map((r) => new Date(r.datetimedisconnect).getTime())
    .filter(Boolean);

  if (!origTimes.length || !discTimes.length) return null;

  const numbers = new Set();
  for (const row of result.rows) {
    if (row.callingpartynumber) numbers.add(row.callingpartynumber);
    if (row.finalcalledpartynumber) numbers.add(row.finalcalledpartynumber);
    if (row.originalcalledpartynumber)
      numbers.add(row.originalcalledpartynumber);
  }

  return {
    clusterId: result.rows[0].globalcallid_clusterid,
    callManagerId: result.rows[0].globalcallid_callmanagerid,
    fromDate: new Date(Math.min(...origTimes) - 30000).toISOString(),
    toDate: new Date(Math.max(...discTimes) + 30000).toISOString(),
    numbers: [...numbers].filter((n) => n.length >= 4 && !/^777777/.test(n)),
  };
}

function createLogsRouter(pool) {
  const router = express.Router();

  // POST /api/v1/cdr/logs/collect
  router.post("/collect", async (req, res) => {
    const { callId, callManagerId } = req.body;
    if (!callId) {
      return res.status(400).json({ error: "callId is required" });
    }

    try {
      const ctx = await lookupCallContext(pool, callId, callManagerId);
      if (!ctx) {
        return res.status(404).json({ error: "No CDR found for this call" });
      }

      const clusterConfig = findClusterConfig(ctx.clusterId);
      if (!clusterConfig) {
        return res.status(400).json({
          error: `No AXL/DIME config for cluster "${ctx.clusterId}"`,
        });
      }

      // Resolve the specific CUCM node that handled this call
      const dimeHost = await resolveNodeHost(clusterConfig, ctx.callManagerId);
      const fromCisco = toCiscoDate(new Date(ctx.fromDate));
      const toCisco = toCiscoDate(new Date(ctx.toDate));
      const tzCisco = CISCO_TZ;
      console.log(
        `DIME collect: host=${dimeHost} cm=${ctx.callManagerId} from=${fromCisco} to=${toCisco}`,
      );

      const logs = await selectLogFiles(
        dimeHost,
        clusterConfig.username,
        clusterConfig.password,
        "Cisco CallManager",
        fromCisco,
        toCisco,
        tzCisco,
      );

      res.json({
        cluster: ctx.clusterId,
        host: dimeHost,
        timeWindow: { from: ctx.fromDate, to: ctx.toDate },
        files: logs.map((f) => ({
          name: f.name,
          path: f.absolutepath,
          size: f.filesize,
          modified: f.modifiedDate,
          server: f.server,
        })),
        count: logs.length,
      });
    } catch (err) {
      console.error(
        `Log collection failed on ${err.host || "unknown"}: ${err.message}`,
        err.statusCode || "",
      );
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/cdr/logs/sip-ladder
  router.post("/sip-ladder", async (req, res) => {
    const { callId, callManagerId } = req.body;
    if (!callId) {
      return res.status(400).json({ error: "callId is required" });
    }

    try {
      const ctx = await lookupCallContext(pool, callId, callManagerId);
      if (!ctx) {
        return res.status(404).json({ error: "No CDR found for this call" });
      }

      const clusterConfig = findClusterConfig(ctx.clusterId);
      if (!clusterConfig) {
        return res.status(400).json({
          error: `No AXL/DIME config for cluster "${ctx.clusterId}"`,
        });
      }

      // Query all subscriber nodes for complete SIP traces
      const allNodes = await getAllNodes(clusterConfig);
      const fromCisco = toCiscoDate(new Date(ctx.fromDate));
      const toCisco = toCiscoDate(new Date(ctx.toDate));
      const tzCisco = CISCO_TZ;
      console.log(
        `DIME sip-ladder: ${allNodes.length} nodes, cm=${ctx.callManagerId} from=${fromCisco} to=${toCisco} numbers=${ctx.numbers.join(",")}`,
      );

      // Query each node for log files
      let allLogs = [];
      for (const node of allNodes) {
        try {
          const logs = await selectLogFiles(
            node,
            clusterConfig.username,
            clusterConfig.password,
            "Cisco CallManager",
            fromCisco,
            toCisco,
            tzCisco,
          );
          allLogs.push(...logs);
        } catch (err) {
          console.warn(`DIME select failed on ${node}: ${err.message}`);
        }
      }

      if (allLogs.length === 0) {
        return res.json({ messages: [], count: 0, files_searched: 0 });
      }

      // Process all files from all nodes
      const allMessages = [];
      let filesSearched = 0;

      for (const file of allLogs) {
        try {
          const result = await getOneFile(
            file.server,
            clusterConfig.username,
            clusterConfig.password,
            file.absolutepath,
          );

          let content;
          if (file.absolutepath.endsWith(".gz")) {
            content = zlib.gunzipSync(result.data).toString("utf8");
          } else {
            content = result.data.toString("utf8");
          }

          const messages = parseSdlTrace(content, ctx.numbers);
          allMessages.push(...messages);
          filesSearched++;
        } catch (fileErr) {
          console.warn(`Failed to process ${file.name}: ${fileErr.message}`);
        }
      }

      allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const callIds = [
        ...new Set(allMessages.map((m) => m.callId).filter(Boolean)),
      ];

      const responseData = {
        messages: allMessages.map((m) => ({
          timestamp: m.timestamp,
          direction: m.direction,
          type: m.type,
          method: m.method || null,
          statusCode: m.statusCode || null,
          reasonPhrase: m.reasonPhrase || null,
          summary: m.summary,
          callId: m.callId,
          fromNumber: m.fromNumber,
          toNumber: m.toNumber,
          from: m.from,
          to: m.to,
          cseq: m.cseq,
          remoteIp: m.remoteIp,
          remotePort: m.remotePort,
          raw: m.raw,
        })),
        count: allMessages.length,
        callIds,
        files_searched: filesSearched,
        timeWindow: { from: ctx.fromDate, to: ctx.toDate },
        node: allNodes.join(","),
      };

      res.json(responseData);

      // Auto-save snapshot to disk (fire and forget)
      try {
        const dir = path.join(SNAPSHOT_DIR, `${callId}-${ctx.callManagerId}`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, "sip-trace.json");
        fs.writeFileSync(filePath, JSON.stringify(responseData), "utf8");
        const fileSize = fs.statSync(filePath).size;
        const relPath = `${callId}-${ctx.callManagerId}/sip-trace.json`;
        pool
          .query(
            `INSERT INTO call_snapshots (globalcallid_callid, globalcallid_callmanagerid, type, file_path, file_size)
           VALUES ($1, $2, 'sip-trace', $3, $4)
           ON CONFLICT (globalcallid_callid, globalcallid_callmanagerid, type, device_name)
           DO UPDATE SET file_path = $3, file_size = $4, created_at = NOW()`,
            [callId, ctx.callManagerId, relPath, fileSize],
          )
          .catch((e) => console.warn("Snapshot save failed:", e.message));
      } catch (e) {
        console.warn("Snapshot write failed:", e.message);
      }
    } catch (err) {
      console.error("SIP ladder failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLogsRouter };
