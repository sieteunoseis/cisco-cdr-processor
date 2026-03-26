const express = require("express");
const {
  searchCdr,
  traceCdr,
  qualityCdr,
  statsCdr,
} = require("../../database/queries");

function createCdrRouter(pool) {
  const router = express.Router();

  // GET /api/v1/cdr/search
  router.get("/search", async (req, res) => {
    try {
      const rows = await searchCdr(pool, req.query);
      res.json({ count: rows.length, results: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/cdr/trace/:callId
  router.get("/trace/:callId", async (req, res) => {
    try {
      const result = await traceCdr(
        pool,
        req.params.callId,
        req.query.callmanager_id,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/cdr/quality
  router.get("/quality", async (req, res) => {
    try {
      const rows = await qualityCdr(pool, req.query);
      res.json({ count: rows.length, results: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/cdr/related/:callId — find related call legs (transfers, conferences)
  router.get("/related/:callId", async (req, res) => {
    try {
      const callManagerId = req.query.callmanager_id;

      // First get the source CDR to extract numbers and time window
      const conditions = ["globalcallid_callid = $1"];
      const values = [req.params.callId];
      if (callManagerId) {
        conditions.push("globalcallid_callmanagerid = $2");
        values.push(callManagerId);
      }

      const source = await pool.query(
        `SELECT callingpartynumber, finalcalledpartynumber, originalcalledpartynumber,
                lastredirectdn, datetimeorigination, datetimedisconnect,
                globalcallid_callid, globalcallid_callmanagerid
         FROM cdr WHERE ${conditions.join(" AND ")}
         ORDER BY datetimeorigination ASC LIMIT 10`,
        values,
      );

      if (source.rows.length === 0) {
        return res.json({ count: 0, results: [] });
      }

      // Use the calling party number as the primary match — this is the actual caller
      // whose call journey we're tracing through the system
      const callers = new Set();
      let minTime = null;
      let maxTime = null;
      for (const row of source.rows) {
        if (row.callingpartynumber) callers.add(row.callingpartynumber);
        const orig = new Date(row.datetimeorigination).getTime();
        const disc = row.datetimedisconnect
          ? new Date(row.datetimedisconnect).getTime()
          : orig;
        if (!minTime || orig < minTime) minTime = orig;
        if (!maxTime || disc > maxTime) maxTime = disc;
      }

      // Remove BIB/recording numbers, CTI route points, and very short numbers
      const filtered = [...callers].filter(
        (n) => n.length >= 4 && !/^b\d{5,}/.test(n) && !/^777777/.test(n),
      );

      if (filtered.length === 0) {
        return res.json({ count: 0, results: [] });
      }

      // Search 2 min window around the call
      const windowStart = new Date(minTime - 120000).toISOString();
      const windowEnd = new Date(maxTime + 120000).toISOString();

      // Match on callingpartynumber only — traces the same caller through the system
      const numConditions = filtered.map((_, i) => {
        const p = i + 3; // $1=start, $2=end, then numbers
        return `c.callingpartynumber = $${p}`;
      });

      const sql = `
        SELECT c.pkid, c.globalcallid_callid, c.globalcallid_callmanagerid,
               c.globalcallid_clusterid, c.callingpartynumber, c.finalcalledpartynumber,
               c.originalcalledpartynumber, c.lastredirectdn, c.origdevicename,
               c.destdevicename, c.datetimeorigination, c.datetimeconnect,
               c.datetimedisconnect, c.duration, c.origcause_value,
               oc.description AS origcause_description,
               c.destcause_value, dc.description AS destcause_description,
               c.origcallterminationonbehalfof, c.destcallterminationonbehalfof,
               c.joinonbehalfof, c.lastredirectredirectreason,
               c.orig_device_description, c.orig_device_type,
               c.dest_device_description, c.dest_device_type
        FROM cdr c
        LEFT JOIN cdr_cause oc ON c.origcause_value = oc.id
        LEFT JOIN cdr_cause dc ON c.destcause_value = dc.id
        WHERE c.datetimeorigination BETWEEN $1 AND $2
          AND (${numConditions.join(" OR ")})
          AND c.globalcallid_callid != $${filtered.length + 3}
        ORDER BY c.datetimeorigination ASC
        LIMIT 50
      `;

      const result = await pool.query(sql, [
        windowStart,
        windowEnd,
        ...filtered,
        parseInt(req.params.callId, 10),
      ]);

      res.json({ count: result.rows.length, results: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/cdr/stats/:type
  router.get("/stats/:type", async (req, res) => {
    try {
      const rows = await statsCdr(pool, {
        type: req.params.type,
        ...req.query,
      });
      res.json({ type: req.params.type, count: rows.length, results: rows });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createCdrRouter };
