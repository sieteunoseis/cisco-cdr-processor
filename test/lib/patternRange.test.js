// test/lib/patternRange.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  resolvePatternRange,
  enumerateMatches,
} = require("../../src/lib/patternRange");

describe("resolvePatternRange", () => {
  it("resolves a simple digit-class tail", () => {
    const result = resolvePatternRange("^5030010[0-1][0-9][0-9]$");
    assert.deepStrictEqual(result, { prefix: "5030010", width: 3 });
  });

  it("resolves an alternation with equal-width branches", () => {
    const result = resolvePatternRange("^5030073(?:8[0-9][0-9]|90[0-7])$");
    assert.deepStrictEqual(result, { prefix: "5030073", width: 3 });
  });

  it("returns null for a pattern with no literal digit prefix", () => {
    const result = resolvePatternRange("^(911|112|999|000|111)$");
    assert.strictEqual(result, null);
  });

  it("returns null for a pattern missing the end anchor", () => {
    const result = resolvePatternRange("^(ATA|AN[0-9A-F])");
    assert.strictEqual(result, null);
  });

  it("returns null for a pattern missing the start anchor", () => {
    const result = resolvePatternRange("5030010[0-9]$");
    assert.strictEqual(result, null);
  });

  it("returns null when width exceeds the 4-digit cap", () => {
    const result = resolvePatternRange(
      "^5030010[0-9][0-9][0-9][0-9][0-9]$",
    );
    assert.strictEqual(result, null);
  });

  it("returns null when a literal prefix contains non-digit characters", () => {
    const result = resolvePatternRange("^ABC[0-9][0-9]$");
    assert.strictEqual(result, null);
  });

  it("returns null when alternation branches have unequal widths", () => {
    const result = resolvePatternRange("^503(?:1[0-9]|2)$");
    assert.strictEqual(result, null);
  });

  it("returns null for a non-string input", () => {
    const result = resolvePatternRange(undefined);
    assert.strictEqual(result, null);
  });
});

describe("enumerateMatches", () => {
  it("enumerates a small explicit range exactly", () => {
    const result = enumerateMatches("^123[0-2]$", "123", 1);
    assert.deepStrictEqual(result, ["1230", "1231", "1232"]);
  });

  it("enumerates the real MWI Lights pattern to exactly 200 numbers", () => {
    const pattern = "^5030010[0-1][0-9][0-9]$";
    const result = enumerateMatches(pattern, "5030010", 3);
    assert.strictEqual(result.length, 200);
    assert.strictEqual(result[0], "5030010000");
    assert.strictEqual(result[result.length - 1], "5030010199");
  });
});
