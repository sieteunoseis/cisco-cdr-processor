const express = require("express");
const fs = require("fs");
const path = require("path");

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || "/data/snapshots";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function callDir(callId, cmId) {
  return path.join(SNAPSHOT_DIR, `${callId}-${cmId}`);
}

function createSnapshotsRouter(pool) {
  const router = express.Router();

  // List snapshots for a call
  router.get("/:callId/:cmId", async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, type, device_name, file_path, file_size, created_at
         FROM call_snapshots
         WHERE globalcallid_callid = $1 AND globalcallid_callmanagerid = $2
         ORDER BY created_at DESC`,
        [req.params.callId, req.params.cmId],
      );
      res.json({ snapshots: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Save a snapshot (called internally by other routes)
  // POST body: { type, deviceName?, content (string or JSON) }
  router.post("/:callId/:cmId", async (req, res) => {
    const { callId, cmId } = req.params;
    const { type, deviceName, content } = req.body || {};

    if (!type || !content) {
      return res.status(400).json({ error: "type and content required" });
    }

    try {
      const dir = callDir(callId, cmId);
      ensureDir(dir);

      const filename = deviceName
        ? `${deviceName}-${type}.${type === "sip-trace" ? "json" : "txt"}`
        : `${type}.${type === "sip-trace" ? "json" : "txt"}`;
      const filePath = path.join(`${callId}-${cmId}`, filename);
      const fullPath = path.join(SNAPSHOT_DIR, filePath);

      const data =
        typeof content === "string" ? content : JSON.stringify(content);
      fs.writeFileSync(fullPath, data, "utf8");
      const fileSize = fs.statSync(fullPath).size;

      await pool.query(
        `INSERT INTO call_snapshots (globalcallid_callid, globalcallid_callmanagerid, type, device_name, file_path, file_size)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (globalcallid_callid, globalcallid_callmanagerid, type, device_name)
         DO UPDATE SET file_path = $5, file_size = $6, created_at = NOW()
         RETURNING *`,
        [callId, cmId, type, deviceName || null, filePath, fileSize],
      );

      res.json({ saved: true, filePath, fileSize });
    } catch (err) {
      console.error("Snapshot save failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Read a snapshot file
  router.get("/:callId/:cmId/:type", async (req, res) => {
    const { callId, cmId, type } = req.params;
    const deviceName = req.query.device || null;

    try {
      const result = await pool.query(
        `SELECT file_path, type FROM call_snapshots
         WHERE globalcallid_callid = $1 AND globalcallid_callmanagerid = $2
           AND type = $3 AND ($4::text IS NULL OR device_name = $4)
         ORDER BY created_at DESC LIMIT 1`,
        [callId, cmId, type, deviceName],
      );

      if (result.rows.length === 0) {
        return res.status(204).end();
      }

      const fullPath = path.join(SNAPSHOT_DIR, result.rows[0].file_path);
      if (!fs.existsSync(fullPath)) {
        return res.status(204).end();
      }

      const content = fs.readFileSync(fullPath, "utf8");

      if (type === "sip-trace") {
        return res.json(JSON.parse(content));
      }
      res.json({ text: content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSnapshotsRouter, SNAPSHOT_DIR, callDir };
