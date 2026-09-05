#!/usr/bin/env node
// One-off backfill: tags existing cdr rows with callingpartynumber_carrier /
// originalcalledpartynumber_carrier / finalcalledpartynumber_carrier /
// lastredirectdn_carrier via the local npanxx table. New rows already get
// this from the live enrichment pipeline (src/enrichment/carrier.js) — this
// script only needs to run once, after that pipeline has been deployed and
// npanxx has been populated.
//
// Batches by pkid (uuid) keyset pagination so it never holds a long-running
// transaction or a full-table lock, and only rewrites rows that actually
// gained a carrier value (skips rows with zero matches) to limit table
// bloat on a 30M+ row table.
//
// Progress (the last-processed pkid) is checkpointed to a local file after
// every batch, so a killed/interrupted run can pick back up with
// --resume instead of rescanning 30M+ rows from the start.
//
// --sleep-ms pauses between batches, giving other queries against the same
// table a share of disk I/O instead of running this back-to-back — useful
// on a live production DB where this table is also serving real traffic.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/backfill-carrier.js [--dry-run] [--batch-size=50000] [--sleep-ms=0] [--resume]

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const batchArg = process.argv.find((a) => a.startsWith("--batch-size="));
const BATCH_SIZE = batchArg ? parseInt(batchArg.split("=")[1], 10) : 50000;
const sleepArg = process.argv.find((a) => a.startsWith("--sleep-ms="));
const SLEEP_MS = sleepArg ? parseInt(sleepArg.split("=")[1], 10) : 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const CHECKPOINT_FILE = path.join(__dirname, ".backfill-carrier-progress");

function loadCheckpoint() {
  if (!RESUME) return NIL_UUID;
  try {
    return fs.readFileSync(CHECKPOINT_FILE, "utf8").trim() || NIL_UUID;
  } catch {
    return NIL_UUID;
  }
}

function saveCheckpoint(pkid) {
  if (!DRY_RUN) fs.writeFileSync(CHECKPOINT_FILE, pkid);
}

async function createHelperFunction() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION nanp_prefix(number text) RETURNS text AS $$
      SELECT CASE
        WHEN number ~ '^[0-9]{10}$' THEN substring(number from 1 for 6)
        WHEN number ~ '^1[0-9]{10}$' THEN substring(number from 2 for 6)
        ELSE NULL
      END;
    $$ LANGUAGE sql IMMUTABLE;
  `);
}

async function dropHelperFunction() {
  await pool.query("DROP FUNCTION IF EXISTS nanp_prefix(text)");
}

const SELECT_BATCH_SQL = `
  SELECT pkid, callingpartynumber, originalcalledpartynumber,
         finalcalledpartynumber, lastredirectdn
  FROM cdr
  WHERE pkid > $1
  ORDER BY pkid
  LIMIT $2
`;

const UPDATE_BATCH_SQL = `
  WITH batch AS (
    SELECT pkid, callingpartynumber, originalcalledpartynumber,
           finalcalledpartynumber, lastredirectdn
    FROM cdr
    WHERE pkid > $1
    ORDER BY pkid
    LIMIT $2
  ),
  matched AS (
    SELECT
      b.pkid,
      n1.company AS calling_carrier,
      n2.company AS orig_carrier,
      n3.company AS final_carrier,
      n4.company AS redirect_carrier
    FROM batch b
    LEFT JOIN npanxx n1 ON n1.prefix = nanp_prefix(b.callingpartynumber)
    LEFT JOIN npanxx n2 ON n2.prefix = nanp_prefix(b.originalcalledpartynumber)
    LEFT JOIN npanxx n3 ON n3.prefix = nanp_prefix(b.finalcalledpartynumber)
    LEFT JOIN npanxx n4 ON n4.prefix = nanp_prefix(b.lastredirectdn)
  )
  UPDATE cdr c SET
    callingpartynumber_carrier = matched.calling_carrier,
    originalcalledpartynumber_carrier = matched.orig_carrier,
    finalcalledpartynumber_carrier = matched.final_carrier,
    lastredirectdn_carrier = matched.redirect_carrier
  FROM matched
  WHERE c.pkid = matched.pkid
    AND (matched.calling_carrier IS NOT NULL
      OR matched.orig_carrier IS NOT NULL
      OR matched.final_carrier IS NOT NULL
      OR matched.redirect_carrier IS NOT NULL)
  RETURNING c.pkid
`;

async function run() {
  await createHelperFunction();

  let lastPkid = loadCheckpoint();
  if (lastPkid !== NIL_UUID) {
    console.log(`Resuming from checkpoint pkid > ${lastPkid}`);
  }
  let scanned = 0;
  let updated = 0;
  const startedAt = Date.now();

  for (;;) {
    const batchResult = await pool.query(
      `SELECT pkid FROM cdr WHERE pkid > $1 ORDER BY pkid LIMIT $2`,
      [lastPkid, BATCH_SIZE],
    );
    if (batchResult.rows.length === 0) break;

    const batchLastPkid = batchResult.rows[batchResult.rows.length - 1].pkid;

    if (DRY_RUN) {
      const preview = await pool.query(SELECT_BATCH_SQL, [lastPkid, BATCH_SIZE]);
      scanned += preview.rows.length;
    } else {
      const result = await pool.query(UPDATE_BATCH_SQL, [lastPkid, BATCH_SIZE]);
      scanned += batchResult.rows.length;
      updated += result.rowCount;
    }

    lastPkid = batchLastPkid;
    saveCheckpoint(lastPkid);

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}scanned ${scanned.toLocaleString()} rows, updated ${updated.toLocaleString()} (${elapsedSec}s elapsed)`,
    );

    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  await dropHelperFunction();
  if (!DRY_RUN) {
    try {
      fs.unlinkSync(CHECKPOINT_FILE);
    } catch {
      // no checkpoint file to clean up
    }
  }
  console.log(
    `Done. Scanned ${scanned.toLocaleString()} rows, updated ${updated.toLocaleString()} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  );
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("Backfill failed:", err);
    await pool.end();
    process.exit(1);
  });
