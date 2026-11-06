const { describe, it } = require("node:test");
const assert = require("node:assert");
const { validateQuery, ensureLimit } = require("../../src/api/routes/sql");

describe("SQL validation", () => {
  it("allows SELECT queries", () => {
    const result = validateQuery("SELECT * FROM cdr_basic LIMIT 10");
    assert.strictEqual(result.valid, true);
  });

  it("allows WITH (CTE) queries", () => {
    const result = validateQuery(
      "WITH recent AS (SELECT * FROM cdr_basic) SELECT * FROM recent",
    );
    assert.strictEqual(result.valid, true);
  });

  it("rejects INSERT", () => {
    const result = validateQuery("INSERT INTO cdr VALUES (1)");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "Only SELECT queries are allowed");
  });

  it("rejects DELETE", () => {
    const result = validateQuery("DELETE FROM cdr");
    assert.strictEqual(result.valid, false);
  });

  it("rejects DROP hidden in a SELECT", () => {
    const result = validateQuery("SELECT 1; DROP TABLE cdr");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "Query contains prohibited keywords");
  });

  it("rejects TRUNCATE", () => {
    const result = validateQuery("TRUNCATE cdr");
    assert.strictEqual(result.valid, false);
  });

  it("rejects UPDATE", () => {
    const result = validateQuery("UPDATE cdr SET pkid = 1");
    assert.strictEqual(result.valid, false);
  });

  it("rejects empty query", () => {
    const result = validateQuery("");
    assert.strictEqual(result.valid, false);
  });

  it("rejects null query", () => {
    const result = validateQuery(null);
    assert.strictEqual(result.valid, false);
  });

  it("strips comments and still validates", () => {
    const result = validateQuery("-- this is a comment\nSELECT 1");
    assert.strictEqual(result.valid, true);
  });

  it("rejects prohibited keyword after comment stripping", () => {
    const result = validateQuery("SELECT 1; /* sneaky */ DROP TABLE cdr");
    assert.strictEqual(result.valid, false);
  });

  it("allows SELECT with subquery containing normal keywords", () => {
    const result = validateQuery(
      "SELECT * FROM cdr_basic WHERE callingpartynumber = '5034181801'",
    );
    assert.strictEqual(result.valid, true);
  });
});

describe("ensureLimit", () => {
  it("appends LIMIT when missing", () => {
    assert.strictEqual(ensureLimit("SELECT 1"), "SELECT 1\nLIMIT 10000");
  });

  it("leaves an existing LIMIT alone", () => {
    assert.strictEqual(ensureLimit("SELECT 1 LIMIT 5"), "SELECT 1 LIMIT 5");
  });

  it("does not append LIMIT after a trailing semicolon", () => {
    assert.strictEqual(ensureLimit("SELECT 1;"), "SELECT 1\nLIMIT 10000");
  });

  it("strips multiple trailing semicolons and whitespace", () => {
    assert.strictEqual(ensureLimit("SELECT 1 ;; \n"), "SELECT 1\nLIMIT 10000");
  });

  it("strips a trailing semicolon even when LIMIT is present", () => {
    assert.strictEqual(ensureLimit("SELECT 1 LIMIT 5;"), "SELECT 1 LIMIT 5");
  });
});
