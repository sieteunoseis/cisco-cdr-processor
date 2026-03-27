const cron = require("node-cron");
const { clearExpired } = require("./enrichment/cache");

function startRetentionJob(pool, retentionDays) {
  if (!retentionDays || retentionDays <= 0) {
    console.log("Retention: disabled (CDR_RETENTION_DAYS=0)");
    return;
  }
  cron.schedule("0 2 * * *", async () => {
    console.log(
      `Retention: purging records older than ${retentionDays} days...`,
    );
    try {
      const cdrResult = await pool.query(
        "DELETE FROM cdr WHERE datetimeorigination < now() - $1 * interval '1 day'",
        [retentionDays],
      );
      console.log(`Retention: deleted ${cdrResult.rowCount} CDR records`);

      const cmrResult = await pool.query(
        "DELETE FROM cmr WHERE datetimestamp < now() - $1 * interval '1 day'",
        [retentionDays],
      );
      console.log(`Retention: deleted ${cmrResult.rowCount} CMR records`);

      await pool.query("VACUUM cdr");
      await pool.query("VACUUM cmr");

      await clearExpired(pool);
      console.log("Retention: complete");
    } catch (err) {
      console.error("Retention error:", err.message);
    }
  });
}

module.exports = { startRetentionJob };
