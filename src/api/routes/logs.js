const express = require("express");
const { selectLogFiles, getOneFile } = require("cisco-dime");
const { parseSdlTrace } = require("../../parser/sdl-parser");
const config = require("../../config");
const zlib = require("zlib");

function findClusterConfig(clusterId) {
  if (!config.axl.clusters || !config.axl.clusters.length || !clusterId) {
    return null;
  }
  return config.axl.clusters.find((c) => c.clusterId === clusterId) || null;
}

async function lookupCallContext(pool, callId, callManagerId) {
  const conditions = ["globalcallid_callid = $1"];
  const values = [callId];
  if (callManagerId) {
    conditions.push("globalcallid_callmanagerid = $2");
    values.push(callManagerId);
  }

  const result = await pool.query(
    `SELECT globalcallid_clusterid, callingpartynumber, finalcalledpartynumber,
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

  // Collect phone numbers for SIP message filtering
  const numbers = new Set();
  for (const row of result.rows) {
    if (row.callingpartynumber) numbers.add(row.callingpartynumber);
    if (row.finalcalledpartynumber) numbers.add(row.finalcalledpartynumber);
    if (row.originalcalledpartynumber)
      numbers.add(row.originalcalledpartynumber);
  }

  return {
    clusterId: result.rows[0].globalcallid_clusterid,
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

      const logs = await selectLogFiles(
        clusterConfig.host,
        clusterConfig.username,
        clusterConfig.password,
        "Cisco CallManager",
        ctx.fromDate,
        ctx.toDate,
        "America/Los_Angeles",
      );

      res.json({
        cluster: ctx.clusterId,
        host: clusterConfig.host,
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
      console.error("Log collection failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/cdr/logs/sip-ladder
  // Downloads SDL files for a call, parses SIP messages, returns ladder data
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

      // Select SDL files in the time window
      const logs = await selectLogFiles(
        clusterConfig.host,
        clusterConfig.username,
        clusterConfig.password,
        "Cisco CallManager",
        ctx.fromDate,
        ctx.toDate,
        "America/Los_Angeles",
      );

      if (logs.length === 0) {
        return res.json({ messages: [], count: 0, files_searched: 0 });
      }

      // Download and parse each file (limit to 5 files to avoid timeouts)
      const filesToProcess = logs.slice(0, 5);
      const allMessages = [];

      for (const file of filesToProcess) {
        try {
          const result = await getOneFile(
            file.server,
            clusterConfig.username,
            clusterConfig.password,
            file.absolutepath,
          );

          // Decompress if gzipped
          let content;
          if (file.absolutepath.endsWith(".gz")) {
            content = zlib.gunzipSync(result.data).toString("utf8");
          } else {
            content = result.data.toString("utf8");
          }

          const messages = parseSdlTrace(content, ctx.numbers);
          allMessages.push(...messages);
        } catch (fileErr) {
          console.warn(`Failed to process ${file.name}: ${fileErr.message}`);
        }
      }

      // Sort by timestamp and deduplicate by removing raw content for response
      allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // Group by Call-ID to identify distinct SIP dialogs
      const callIds = [
        ...new Set(allMessages.map((m) => m.callId).filter(Boolean)),
      ];

      res.json({
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
        files_searched: filesToProcess.length,
        timeWindow: { from: ctx.fromDate, to: ctx.toDate },
      });
    } catch (err) {
      console.error("SIP ladder failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLogsRouter };
