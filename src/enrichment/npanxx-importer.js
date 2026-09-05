// Downloads NANPA's public Central Office Code Assignment report and loads
// it into the local npanxx table for carrier enrichment (see carrier.js).
// Each download is a full snapshot, so refresh is a truncate + reload rather
// than an incremental diff.

const cron = require("node-cron");
const AdmZip = require("adm-zip");
const { parseNpanxxFile } = require("./npanxx-parser");

const REPORT_URL =
  "https://reports.nanpa.com/public/CoCodeAssignment_Utilized_AllStates_Public.zip";

const INSERT_CHUNK_SIZE = 1000;

async function downloadReport(url = REPORT_URL) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NANPA report download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error("NANPA report zip contained no files");
  }
  return entries[0].getData().toString("utf8");
}

async function loadNpanxxRecords(pool, records) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE npanxx");

    for (let i = 0; i < records.length; i += INSERT_CHUNK_SIZE) {
      const chunk = records.slice(i, i + INSERT_CHUNK_SIZE);
      const values = [];
      const rows = chunk.map((r, idx) => {
        const base = idx * 6;
        values.push(r.prefix, r.state, r.rateCenter, r.company, r.ocn, r.assignDate);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, now())`;
      });

      await client.query(
        `INSERT INTO npanxx (prefix, state, rate_center, company, ocn, assignment_date, updated_at)
         VALUES ${rows.join(", ")}`,
        values,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function refreshNpanxx(pool, url) {
  console.log("NPA-NXX carrier data: downloading NANPA CO code report...");
  const text = await downloadReport(url);
  const records = parseNpanxxFile(text);
  console.log(
    `NPA-NXX carrier data: parsed ${records.length} assigned NPA-NXX codes`,
  );
  await loadNpanxxRecords(pool, records);
  console.log("NPA-NXX carrier data: loaded into database");
}

async function ensureNpanxxData(pool) {
  const result = await pool.query("SELECT count(*) AS total FROM npanxx");
  if (parseInt(result.rows[0].total, 10) > 0) return;

  console.log("NPA-NXX carrier table is empty — running initial import...");
  try {
    await refreshNpanxx(pool);
  } catch (err) {
    console.error("Initial NPA-NXX import failed:", err.message);
  }
}

function startNpanxxImportJob(pool) {
  // NANPA's CO code report changes slowly (new/reassigned blocks); a
  // weekly refresh is plenty for troubleshooting/reference purposes.
  cron.schedule("0 3 * * 0", async () => {
    try {
      await refreshNpanxx(pool);
    } catch (err) {
      console.error("NPA-NXX carrier data refresh failed:", err.message);
    }
  });
}

module.exports = {
  REPORT_URL,
  downloadReport,
  loadNpanxxRecords,
  refreshNpanxx,
  ensureNpanxxData,
  startNpanxxImportJob,
};
