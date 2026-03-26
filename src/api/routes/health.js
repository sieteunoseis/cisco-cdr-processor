const express = require("express");
const config = require("../../config");
const { healthCheck } = require("../../database/queries");
const { version } = require("../../../package.json");

function createHealthRouter(pool) {
  const router = express.Router();

  // GET /api/v1/health
  router.get("/", async (req, res) => {
    try {
      const result = await healthCheck(pool, config.cdr.incomingDir);
      result.version = version;
      res.json(result);
    } catch (err) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
