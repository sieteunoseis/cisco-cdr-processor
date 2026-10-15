const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { parseFilename } = require("../watcher/file-parser");
const { parseCdrFile } = require("../parser/cdr-parser");
const { parseCmrFile } = require("../parser/cmr-parser");

// A CUCM CDR row has 133 columns, a CMR row 48 — anything above this is a CDR.
const CDR_MIN_COLUMNS = 80;

function isZip(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

function sanitizeFilename(name) {
  const base = path.posix.basename(String(name || "").replace(/\\/g, "/")).trim();
  const clean = base.replace(/[^\w.-]/g, "_");
  return clean && clean !== "." && clean !== ".." ? clean : null;
}

// Determine cdr/cmr: explicit override > CUCM filename convention > content.
function detectType(filename, content, override) {
  if (override === "cdr" || override === "cmr") return override;
  const fromName = parseFilename(filename);
  if (fromName) return fromName.type;
  const firstLine = content.toString("utf8", 0, 8192).split(/\r?\n/)[0];
  if (!firstLine.trim()) return null;
  return firstLine.split(",").length >= CDR_MIN_COLUMNS ? "cdr" : "cmr";
}

// Expand an upload into a list of { filename, content } entries. ZIP archives
// are flattened; directories and hidden/macOS metadata entries are ignored.
function expandUpload(filename, buffer) {
  if (!isZip(buffer)) return [{ filename, content: buffer }];
  const zip = new AdmZip(buffer);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX/"))
    .map((e) => ({ filename: sanitizeFilename(e.entryName), entry: e }))
    .filter(({ filename: f }) => f && !f.startsWith("."))
    .map(({ filename: f, entry }) => ({ filename: f, content: entry.getData() }));
}

async function logResult(pool, filename, type, info, inserted, timeMs, error, force) {
  const conflict = force
    ? `ON CONFLICT (filename) DO UPDATE SET file_type = EXCLUDED.file_type,
         records_inserted = EXCLUDED.records_inserted, processed_at = EXCLUDED.processed_at,
         processing_time_ms = EXCLUDED.processing_time_ms, error = EXCLUDED.error`
    : "ON CONFLICT (filename) DO NOTHING";
  await pool.query(
    `INSERT INTO file_processing_log (filename, file_type, cluster, node, file_date, sequence, records_inserted, processed_at, processing_time_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9) ${conflict}`,
    [
      filename,
      type,
      info?.cluster ?? null,
      info?.node ?? null,
      info?.date ?? null,
      info?.sequence ?? null,
      inserted,
      timeMs,
      error,
    ],
  );
}

// Import a single CDR/CMR file held in memory. Records are deduplicated by
// pkid on insert, so forcing a re-import never creates duplicate rows.
async function importBuffer(pool, rawFilename, content, opts = {}) {
  const { writers = {}, force = false, type: typeOverride } = opts;
  const filename = sanitizeFilename(rawFilename);
  const result = { filename: filename || String(rawFilename), type: null };
  const startTime = Date.now();

  if (!filename) {
    return { ...result, status: "error", error: "Invalid filename" };
  }

  const type = detectType(filename, content, typeOverride);
  result.type = type;
  if (!type) return { ...result, status: "error", error: "Empty file" };

  const info = parseFilename(filename);

  if (!force) {
    const existing = await pool.query(
      "SELECT processed_at FROM file_processing_log WHERE filename = $1",
      [filename],
    );
    if (existing.rows.length > 0) {
      return {
        ...result,
        status: "skipped",
        reason: "already processed (use force to re-import)",
        processed_at: existing.rows[0].processed_at,
      };
    }
  }

  // Parsers read from disk, so stage the content in a private temp dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdr-import-"));
  const tmpPath = path.join(tmpDir, filename);
  try {
    fs.writeFileSync(tmpPath, content);
    const records =
      type === "cdr" ? await parseCdrFile(tmpPath) : await parseCmrFile(tmpPath);

    const writer = type === "cdr" ? writers.cdrWriter : writers.cmrWriter;
    const inserted = writer ? await writer(pool, records) : 0;
    const timeMs = Date.now() - startTime;

    await logResult(pool, filename, type, info, inserted, timeMs, null, force);
    console.log(
      `Manual import ${filename}: ${inserted}/${records.length} records inserted in ${timeMs}ms`,
    );
    return {
      ...result,
      status: "imported",
      records_parsed: records.length,
      records_inserted: inserted,
      duplicates: records.length - inserted,
      processing_time_ms: timeMs,
    };
  } catch (err) {
    const timeMs = Date.now() - startTime;
    console.error(`Manual import ${filename} failed:`, err.message);
    try {
      await logResult(pool, filename, type, info, 0, timeMs, err.message, force);
    } catch (logErr) {
      console.error("Failed to log error:", logErr.message);
    }
    return { ...result, status: "error", error: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Import an upload (single file or ZIP of files). Returns one result per file.
async function importUpload(pool, filename, buffer, opts = {}) {
  let entries;
  try {
    entries = expandUpload(filename, buffer);
  } catch (err) {
    return [{ filename, status: "error", error: `Invalid ZIP: ${err.message}` }];
  }
  const results = [];
  for (const { filename: f, content } of entries) {
    results.push(await importBuffer(pool, f, content, opts));
  }
  return results;
}

function summarize(results) {
  const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    files: results.length,
    imported: results.filter((r) => r.status === "imported").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    records_parsed: sum("records_parsed"),
    records_inserted: sum("records_inserted"),
  };
}

module.exports = {
  importBuffer,
  importUpload,
  expandUpload,
  detectType,
  sanitizeFilename,
  summarize,
  isZip,
};
