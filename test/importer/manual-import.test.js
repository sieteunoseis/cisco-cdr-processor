const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const {
  importBuffer,
  importUpload,
  expandUpload,
  detectType,
  sanitizeFilename,
} = require("../../src/importer/manual-import");

const CDR = fs.readFileSync(path.join(__dirname, "../fixtures/sample_cdr.txt"));
const CMR = fs.readFileSync(path.join(__dirname, "../fixtures/sample_cmr.txt"));

// Minimal pg pool stub: records queries, reports no previously-processed files.
function fakePool(processed = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT") && processed.includes(params[0])) {
        return { rows: [{ processed_at: new Date() }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const countingWriters = {
  cdrWriter: async (pool, records) => records.length,
  cmrWriter: async (pool, records) => records.length,
};

describe("sanitizeFilename", () => {
  it("strips directories and unsafe characters", () => {
    assert.strictEqual(sanitizeFilename("../../etc/passwd"), "passwd");
    assert.strictEqual(sanitizeFilename("C:\\dir\\cdr_A_01_2026_1"), "cdr_A_01_2026_1");
    assert.strictEqual(sanitizeFilename("my file;rm.txt"), "my_file_rm.txt");
  });

  it("rejects empty names", () => {
    assert.strictEqual(sanitizeFilename(""), null);
    assert.strictEqual(sanitizeFilename(".."), null);
    assert.strictEqual(sanitizeFilename(undefined), null);
  });
});

describe("detectType", () => {
  it("uses the override first", () => {
    assert.strictEqual(detectType("cdr_A_01_202603251541_1", CDR, "cmr"), "cmr");
  });

  it("uses the CUCM filename convention", () => {
    assert.strictEqual(detectType("cmr_A_01_202603251541_1", CDR), "cmr");
  });

  it("falls back to the column count", () => {
    assert.strictEqual(detectType("export.csv", CDR), "cdr");
    assert.strictEqual(detectType("export.csv", CMR), "cmr");
    assert.strictEqual(detectType("empty.csv", Buffer.from("")), null);
  });
});

describe("expandUpload", () => {
  it("passes plain files through", () => {
    const entries = expandUpload("cdr_x", CDR);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].filename, "cdr_x");
  });

  it("flattens ZIP archives and skips metadata", () => {
    const zip = new AdmZip();
    zip.addFile("batch/cdr_A_01_202603251541_1", CDR);
    zip.addFile("batch/cmr_A_01_202603251541_2", CMR);
    zip.addFile("__MACOSX/batch/._cdr_A_01_202603251541_1", Buffer.from("x"));
    zip.addFile("batch/.DS_Store", Buffer.from("x"));
    const entries = expandUpload("batch.zip", zip.toBuffer());
    assert.deepStrictEqual(
      entries.map((e) => e.filename),
      ["cdr_A_01_202603251541_1", "cmr_A_01_202603251541_2"],
    );
  });
});

describe("importBuffer", () => {
  it("parses, writes and logs a CDR file", async () => {
    const pool = fakePool();
    const r = await importBuffer(pool, "cdr_A_01_202603251541_1", CDR, {
      writers: countingWriters,
    });
    assert.strictEqual(r.status, "imported");
    assert.strictEqual(r.type, "cdr");
    assert.ok(r.records_parsed > 0);
    assert.strictEqual(r.records_inserted, r.records_parsed);
    const log = pool.queries.find((q) => q.sql.includes("INSERT INTO file_processing_log"));
    assert.deepStrictEqual(log.params.slice(0, 6), ["cdr_A_01_202603251541_1", "cdr", "A", "01", "202603251541", "1"]);
  });

  it("skips files already processed unless forced", async () => {
    const name = "cmr_A_01_202603251541_2";
    const skipped = await importBuffer(fakePool([name]), name, CMR, { writers: countingWriters });
    assert.strictEqual(skipped.status, "skipped");

    const pool = fakePool([name]);
    const forced = await importBuffer(pool, name, CMR, { writers: countingWriters, force: true });
    assert.strictEqual(forced.status, "imported");
    assert.ok(pool.queries.some((q) => q.sql.includes("DO UPDATE")));
  });

  it("reports writer failures as errors", async () => {
    const r = await importBuffer(fakePool(), "cdr_A_01_202603251541_3", CDR, {
      writers: { cdrWriter: async () => { throw new Error("db down"); } },
    });
    assert.strictEqual(r.status, "error");
    assert.strictEqual(r.error, "db down");
  });
});

describe("importUpload", () => {
  it("imports every file in a ZIP", async () => {
    const zip = new AdmZip();
    zip.addFile("cdr_A_01_202603251541_1", CDR);
    zip.addFile("cmr_A_01_202603251541_2", CMR);
    const results = await importUpload(fakePool(), "b.zip", zip.toBuffer(), {
      writers: countingWriters,
    });
    assert.deepStrictEqual(results.map((r) => [r.type, r.status]), [
      ["cdr", "imported"],
      ["cmr", "imported"],
    ]);
  });
});
