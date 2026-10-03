#!/usr/bin/env node
// Manually import CUCM CDR/CMR files (or ZIPs of them) from disk.
//
// Usage:
//   node scripts/import-cdr.js [--force] [--type cdr|cmr] <file|dir> [...]
//
// In Docker:
//   docker exec cisco-cucm-cdr node scripts/import-cdr.js /data/manual

const fs = require("fs");
const path = require("path");
const pool = require("../src/database/pool");
const { initSchema } = require("../src/database/schema");
const { writers } = require("../src/database/writers");
const { importUpload, summarize } = require("../src/importer/manual-import");

function usage() {
  console.error(
    "Usage: node scripts/import-cdr.js [--force] [--type cdr|cmr] <file|dir> [...]",
  );
  process.exit(2);
}

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => !f.startsWith("."))
    .map((f) => path.join(target, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort();
}

async function main() {
  const args = process.argv.slice(2);
  let force = false;
  let type;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force") force = true;
    else if (args[i] === "--type") type = args[++i];
    else if (args[i] === "-h" || args[i] === "--help") usage();
    else targets.push(args[i]);
  }
  if (!targets.length || (type && type !== "cdr" && type !== "cmr")) usage();

  await initSchema(pool);

  const results = [];
  for (const file of targets.flatMap(collectFiles)) {
    const fileResults = await importUpload(
      pool,
      path.basename(file),
      fs.readFileSync(file),
      { writers, force, type },
    );
    for (const r of fileResults) {
      const detail =
        r.status === "imported"
          ? `${r.records_inserted}/${r.records_parsed} inserted`
          : r.error || r.reason;
      console.log(`${r.status.padEnd(8)} ${r.filename}  ${detail}`);
    }
    results.push(...fileResults);
  }

  const s = summarize(results);
  console.log(
    `\n${s.files} file(s): ${s.imported} imported, ${s.skipped} skipped, ${s.errors} error(s), ${s.records_inserted} record(s) inserted`,
  );
  await pool.end();
  process.exit(s.errors ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Import failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
