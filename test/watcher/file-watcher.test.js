const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  sweepDir,
  processFile,
  isTransientError,
} = require("../../src/watcher/file-watcher");

const CDR = fs.readFileSync(path.join(__dirname, "../fixtures/sample_cdr.txt"));

function stageFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, CDR);
  return file;
}

const dnsError = () =>
  Object.assign(new Error("getaddrinfo EAI_AGAIN db.example.com"), {
    code: "EAI_AGAIN",
  });

describe("isTransientError", () => {
  it("flags network and connection errors", () => {
    assert.ok(isTransientError(dnsError()));
    assert.ok(
      isTransientError(new Error("Connection terminated unexpectedly")),
    );
    assert.ok(
      isTransientError(Object.assign(new Error("x"), { code: "ENETUNREACH" })),
    );
  });

  it("does not flag data errors", () => {
    const err = Object.assign(
      new Error('value "4294967295" is out of range for type integer'),
      { code: "22003" },
    );
    assert.ok(!isTransientError(err));
  });
});

describe("processFile", () => {
  it("retries transient errors without logging the file as processed", async () => {
    const file = stageFile("cdr_A_01_202603251541_1");
    const queries = [];
    let calls = 0;
    const pool = {
      query: async (sql, params) => {
        queries.push(sql);
        calls++;
        if (calls === 1) throw dnsError(); // first dedup check fails
        return { rows: [] };
      },
    };
    await processFile(pool, file, {
      cdrWriter: async (p, records) => records.length,
      retryDelayMs: 10,
    });
    assert.ok(fs.existsSync(file), "file left in place for retry");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(file), "file processed on retry");
    assert.ok(
      !queries.some((q) => q.includes("error)")),
      "no error row logged",
    );
  });

  it("logs permanent errors", async () => {
    const file = stageFile("cdr_A_01_202603251541_2");
    const queries = [];
    const pool = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    await processFile(pool, file, {
      cdrWriter: async () => {
        throw new Error("bad data");
      },
    });
    assert.ok(
      queries.some((q) => q.includes("error)")),
      "error row logged",
    );
  });
});

describe("sweepDir", () => {
  const okPool = () => ({ query: async () => ({ rows: [] }) });

  it("processes files left behind in the incoming dir", async () => {
    const file = stageFile("cdr_A_01_202603251541_3");
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(file, old, old);
    await sweepDir(okPool(), path.dirname(file), {
      cdrWriter: async (p, records) => records.length,
    });
    assert.ok(!fs.existsSync(file), "leftover file processed");
  });

  it("leaves recently written files to the watcher", async () => {
    const file = stageFile("cdr_A_01_202603251541_4");
    await sweepDir(okPool(), path.dirname(file), {
      cdrWriter: async (p, records) => records.length,
    });
    assert.ok(fs.existsSync(file), "fresh file untouched");
  });
});
