const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { parseFilename } = require("./file-parser");
const { parseCdrFile } = require("../parser/cdr-parser");
const { parseCmrFile } = require("../parser/cmr-parser");

// Network/database errors that are worth retrying (DNS blips, DB restarts).
// Files failing with these are left in place and retried instead of being
// logged as processed-with-error, which would make the watcher skip them.
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);
const MAX_RETRIES = 5;

// Files currently being processed or waiting on a retry timer, so the
// periodic sweep doesn't pick them up a second time.
const inFlight = new Set();
// Files skipped as already processed; only log the skip once per file.
const skipped = new Set();

function isTransientError(err) {
  return (
    TRANSIENT_CODES.has(err.code) ||
    /Connection terminated|timeout exceeded when trying to connect/i.test(
      err.message,
    )
  );
}

function startWatcher(pool, opts = {}) {
  const dir = opts.incomingDir || config.cdr.incomingDir;
  console.log(`File watcher: watching ${dir}`);

  const watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false, // Process existing files on startup
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  watcher.on("add", async (filePath) => {
    await processFile(pool, filePath, opts);
  });

  watcher.on("error", (err) => {
    console.error("File watcher error:", err.message);
  });

  // Files left behind after retries were exhausted (e.g. a long DB outage)
  // only get a new "add" event on restart, so rescan the directory.
  const sweepMs = opts.sweepIntervalMs ?? 5 * 60 * 1000;
  const sweep = setInterval(() => sweepDir(pool, dir, opts), sweepMs);
  sweep.unref();
  watcher.on("close", () => clearInterval(sweep));

  return watcher;
}

async function sweepDir(pool, dir, opts = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    console.error("Sweep failed to read incoming dir:", err.message);
    return;
  }
  for (const name of names) {
    const filePath = path.join(dir, name);
    if (inFlight.has(filePath) || skipped.has(filePath)) continue;
    // Leave files still being written over SFTP to the watcher.
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs < 60000) continue;
    } catch {
      continue; // removed since readdir
    }
    await processFile(pool, filePath, opts);
  }
}

async function processFile(pool, filePath, opts = {}, attempt = 0) {
  const fileInfo = parseFilename(filePath);
  if (!fileInfo) return; // Not a CDR/CMR file, skip silently

  const filename = path.basename(filePath);
  const startTime = Date.now();

  if (attempt === 0) {
    if (inFlight.has(filePath)) return;
    inFlight.add(filePath);
  }
  let retrying = false;

  try {
    // Check dedup — skip if already processed
    const existing = await pool.query(
      "SELECT filename FROM file_processing_log WHERE filename = $1",
      [filename],
    );
    if (existing.rows.length > 0) {
      if (!skipped.has(filePath)) {
        console.log(`Skipping already processed: ${filename}`);
        skipped.add(filePath);
      }
      return;
    }

    // Parse CSV
    let records;
    if (fileInfo.type === "cdr") {
      records = await parseCdrFile(filePath);
    } else {
      records = await parseCmrFile(filePath);
    }

    // NOTE: AXL enrichment will be wired in here later (Task 12)
    // if (fileInfo.type === 'cdr') {
    //   records = await enrichCdrRecords(pool, records, config.axl);
    // }

    // Insert records (writers will be implemented in Task 6)
    let recordsInserted = 0;
    if (opts.cdrWriter && fileInfo.type === "cdr") {
      recordsInserted = await opts.cdrWriter(pool, records);
    } else if (opts.cmrWriter && fileInfo.type === "cmr") {
      recordsInserted = await opts.cmrWriter(pool, records);
    } else {
      recordsInserted = records.length;
    }

    // Log success
    const processingTime = Date.now() - startTime;
    await pool.query(
      `INSERT INTO file_processing_log (filename, file_type, cluster, node, file_date, sequence, records_inserted, processed_at, processing_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
      [
        filename,
        fileInfo.type,
        fileInfo.cluster,
        fileInfo.node,
        fileInfo.date,
        fileInfo.sequence,
        recordsInserted,
        processingTime,
      ],
    );

    // Delete processed file
    fs.unlinkSync(filePath);
    console.log(
      `Processed ${filename}: ${recordsInserted} records in ${processingTime}ms`,
    );
  } catch (err) {
    const processingTime = Date.now() - startTime;

    if (isTransientError(err)) {
      if (attempt < MAX_RETRIES) {
        const delay = (opts.retryDelayMs ?? 30000) * 2 ** attempt;
        console.warn(
          `Transient error processing ${filename} (${err.message}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`,
        );
        retrying = true;
        setTimeout(() => {
          processFile(pool, filePath, opts, attempt + 1);
        }, delay);
      } else {
        console.error(
          `Giving up on ${filename} after ${MAX_RETRIES} retries (${err.message}); left in place for next sweep`,
        );
      }
      return;
    }

    console.error(`Error processing ${filename}:`, err.message);

    // Log error
    try {
      await pool.query(
        `INSERT INTO file_processing_log (filename, file_type, cluster, node, file_date, sequence, records_inserted, processed_at, processing_time_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, 0, now(), $7, $8)
         ON CONFLICT (filename) DO NOTHING`,
        [
          filename,
          fileInfo.type,
          fileInfo.cluster,
          fileInfo.node,
          fileInfo.date,
          fileInfo.sequence,
          processingTime,
          err.message,
        ],
      );
    } catch (logErr) {
      console.error("Failed to log error:", logErr.message);
    }
  } finally {
    if (!retrying) inFlight.delete(filePath);
  }
}

module.exports = { startWatcher, sweepDir, processFile, isTransientError };
