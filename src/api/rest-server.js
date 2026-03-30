const express = require("express");
const { createCdrRouter } = require("./routes/cdr");
const { createHealthRouter } = require("./routes/health");
const { createSqlRouter } = require("./routes/sql");
const { createLogsRouter } = require("./routes/logs");
const { createStarredRouter } = require("./routes/starred");
const { createDeviceRouter } = require("./routes/device");
const { createSnapshotsRouter } = require("./routes/snapshots");

function createRestServer(pool) {
  const app = express();

  app.use(express.json());

  // CORS
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", corsOrigin);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Mount routes
  app.use("/api/v1/cdr", createCdrRouter(pool));
  app.use("/api/v1/cdr/sql", createSqlRouter(pool));
  app.use("/api/v1/cdr/logs", createLogsRouter(pool));
  app.use("/api/v1/health", createHealthRouter(pool));
  app.use("/api/v1/starred", createStarredRouter(pool));
  app.use("/api/v1/device", createDeviceRouter());
  app.use("/api/v1/snapshots", createSnapshotsRouter(pool));

  // 404 fallback for unknown API routes
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

module.exports = { createRestServer };
