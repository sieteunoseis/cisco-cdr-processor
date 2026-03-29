const express = require("express");

function createStarredRouter(pool) {
  const router = express.Router();

  // List starred calls (with CDR summary)
  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT s.*,
               c.callingpartynumber, c.finalcalledpartynumber,
               c.originalcalledpartynumber, c.origdevicename, c.destdevicename,
               c.datetimeorigination, c.datetimeconnect, c.datetimedisconnect,
               c.duration, c.destcause_value,
               c.orig_device_description, c.dest_device_description,
               cc.description AS destcause_description
        FROM starred_calls s
        LEFT JOIN cdr c ON c.globalcallid_callid = s.globalcallid_callid
          AND c.globalcallid_callmanagerid = s.globalcallid_callmanagerid
        LEFT JOIN cdr_cause cc ON c.destcause_value = cc.id
        ORDER BY s.created_at DESC
        LIMIT 100
      `);
      res.json({ starred: result.rows, count: result.rowCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk check which calls are starred
  router.post("/check", async (req, res) => {
    try {
      const { calls } = req.body || {};
      if (!Array.isArray(calls) || calls.length === 0) {
        return res.json({ starred: {} });
      }
      // Build query for all call IDs
      const pairs = calls
        .slice(0, 200)
        .map((c) => [String(c.callId), String(c.callManagerId)]);
      const result = await pool.query(
        `SELECT globalcallid_callid, globalcallid_callmanagerid
         FROM starred_calls
         WHERE (globalcallid_callid, globalcallid_callmanagerid)
         IN (${pairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})`,
        pairs.flat(),
      );
      const starredMap = {};
      for (const row of result.rows) {
        starredMap[
          `${row.globalcallid_callid}:${row.globalcallid_callmanagerid}`
        ] = true;
      }
      res.json({ starred: starredMap });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check if a call is starred
  router.get("/:callId/:callManagerId", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM starred_calls WHERE globalcallid_callid = $1 AND globalcallid_callmanagerid = $2",
        [req.params.callId, req.params.callManagerId],
      );
      res.json({ starred: result.rowCount > 0, data: result.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Star a call
  router.post("/:callId/:callManagerId", async (req, res) => {
    try {
      const { note, starred_by } = req.body || {};
      const result = await pool.query(
        `INSERT INTO starred_calls (globalcallid_callid, globalcallid_callmanagerid, note, starred_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (globalcallid_callid, globalcallid_callmanagerid)
         DO UPDATE SET note = COALESCE(NULLIF($3, ''), starred_calls.note), starred_by = COALESCE(NULLIF($4, ''), starred_calls.starred_by)
         RETURNING *`,
        [
          req.params.callId,
          req.params.callManagerId,
          note || "",
          starred_by || "",
        ],
      );
      res.json({ starred: true, data: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unstar a call
  router.delete("/:callId/:callManagerId", async (req, res) => {
    try {
      await pool.query(
        "DELETE FROM starred_calls WHERE globalcallid_callid = $1 AND globalcallid_callmanagerid = $2",
        [req.params.callId, req.params.callManagerId],
      );
      res.json({ starred: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createStarredRouter };
