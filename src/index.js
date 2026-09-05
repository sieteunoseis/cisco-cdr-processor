// Syslog-style timestamps on all console output
const _log = console.log;
const _warn = console.warn;
const _error = console.error;
const _debug = console.debug;
const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const logLevel = process.env.LOG_LEVEL || "info";
console.log = (...args) => _log(ts(), "INFO", ...args);
console.warn = (...args) => _warn(ts(), "WARN", ...args);
console.error = (...args) => _error(ts(), "ERROR", ...args);
console.debug =
  logLevel === "debug" ? (...args) => _debug(ts(), "DEBUG", ...args) : () => {};

const config = require("./config");
const pool = require("./database/pool");
const { initSchema } = require("./database/schema");
const { startWatcher } = require("./watcher/file-watcher");
const { insertCdrRecords } = require("./database/cdr-writer");
const { insertCmrRecords } = require("./database/cmr-writer");
const { createRestServer } = require("./api/rest-server");
const { createMcpServer } = require("./mcp/mcp-server");
const { startRetentionJob } = require("./retention");
const { enrichCdrRecords } = require("./enrichment/enricher");
const { enrichCarrier } = require("./enrichment/carrier");
const {
  ensureNpanxxData,
  startNpanxxImportJob,
} = require("./enrichment/npanxx-importer");

async function waitForDatabase(maxRetries = 10, delayMs = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      console.log(`Waiting for database... (${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Database connection failed after retries");
}

async function main() {
  console.log("cisco-cucm-cdr starting...");

  await waitForDatabase();
  await initSchema(pool);

  const app = createRestServer(pool);
  await createMcpServer(app, pool);

  app.listen(config.server.port, () => {
    console.log(`MCP + REST API listening on port ${config.server.port}`);
  });

  startWatcher(pool, {
    cdrWriter: async (p, records) => {
      const enriched = await enrichCdrRecords(p, records, config.axl);
      const withCarrier = await enrichCarrier(p, enriched);
      return insertCdrRecords(p, withCarrier);
    },
    cmrWriter: insertCmrRecords,
  });

  startRetentionJob(pool, config.cdr.retentionDays);

  await ensureNpanxxData(pool);
  startNpanxxImportJob(pool);

  console.log("cisco-cucm-cdr ready.");
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
