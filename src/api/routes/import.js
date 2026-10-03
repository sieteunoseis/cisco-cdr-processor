const express = require("express");
const {
  importUpload,
  sanitizeFilename,
  summarize,
} = require("../../importer/manual-import");

const MAX_SIZE = process.env.IMPORT_MAX_SIZE || "100mb";

function createImportRouter(pool, writers) {
  const router = express.Router();

  // POST /api/v1/cdr/import?filename=cdr_...&type=cdr|cmr&force=true
  // Body: raw file bytes (a CUCM CDR/CMR flat file, or a ZIP of them).
  router.post(
    "/",
    express.raw({ type: () => true, limit: MAX_SIZE }),
    async (req, res) => {
      const filename = sanitizeFilename(
        req.query.filename || req.get("X-Filename"),
      );
      if (!filename) {
        return res.status(400).json({
          error: "filename query parameter (or X-Filename header) is required",
        });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "Request body is empty" });
      }
      const type = req.query.type || undefined;
      if (type && type !== "cdr" && type !== "cmr") {
        return res.status(400).json({ error: "type must be 'cdr' or 'cmr'" });
      }

      try {
        const results = await importUpload(pool, filename, req.body, {
          writers,
          type,
          force: req.query.force === "true" || req.query.force === "1",
        });
        const summary = summarize(results);
        const status =
          summary.files > 0 && summary.errors === summary.files ? 422 : 200;
        res.status(status).json({ summary, results });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // GET /api/v1/cdr/import/history?limit=50
  router.get("/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      const result = await pool.query(
        `SELECT filename, file_type, cluster, node, records_inserted,
                processed_at, processing_time_ms, error
         FROM file_processing_log
         ORDER BY processed_at DESC
         LIMIT $1`,
        [limit],
      );
      res.json({ count: result.rows.length, results: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createImportRouter };
