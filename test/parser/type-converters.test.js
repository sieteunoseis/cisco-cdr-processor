const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  epochToDate,
  epochToDateNullable,
  intToIp,
  stringToIp,
  secondsToInterval,
  emptyToNull,
  parseInt32,
  parseVarVQMetrics,
} = require("../../src/parser/type-converters");

describe("epochToDate", () => {
  it("converts Unix epoch seconds to Date", () => {
    const date = epochToDate(1711386104);
    assert.ok(date instanceof Date);
    assert.strictEqual(date.toISOString(), "2024-03-25T17:01:44.000Z");
  });
});

describe("epochToDateNullable", () => {
  it("returns null for 0", () => {
    assert.strictEqual(epochToDateNullable(0), null);
  });
  it("returns null for empty string", () => {
    assert.strictEqual(epochToDateNullable(""), null);
  });
  it("converts valid epoch", () => {
    const date = epochToDateNullable(1711382504);
    assert.ok(date instanceof Date);
  });
});

describe("intToIp", () => {
  it("converts integer to IPv4 string", () => {
    assert.strictEqual(intToIp(167772161), "10.0.0.1");
  });
  it("returns null for 0", () => {
    assert.strictEqual(intToIp(0), null);
  });
});

describe("stringToIp", () => {
  it("returns IPv4 as-is", () => {
    assert.strictEqual(stringToIp("10.0.0.1"), "10.0.0.1");
  });
  it("returns null for empty string", () => {
    assert.strictEqual(stringToIp(""), null);
  });
});

describe("secondsToInterval", () => {
  it("converts seconds to PG interval string", () => {
    assert.strictEqual(secondsToInterval(125), "125 seconds");
  });
  it("returns null for 0", () => {
    assert.strictEqual(secondsToInterval(0), null);
  });
});

describe("emptyToNull", () => {
  it("returns null for empty string", () => {
    assert.strictEqual(emptyToNull(""), null);
  });
  it("passes through non-empty string", () => {
    assert.strictEqual(emptyToNull("hello"), "hello");
  });
});

describe("parseVarVQMetrics", () => {
  it("parses semicolon-delimited key=value pairs", () => {
    const result = parseVarVQMetrics("MLQK=3.5;MLQKav=3.4;ICR=0.005");
    assert.deepStrictEqual(result, { MLQK: 3.5, MLQKav: 3.4, ICR: 0.005 });
  });
  it("returns empty object for empty string", () => {
    assert.deepStrictEqual(parseVarVQMetrics(""), {});
  });
  it("returns empty object for null", () => {
    assert.deepStrictEqual(parseVarVQMetrics(null), {});
  });
});

describe("parseInt32", () => {
  it("parses normal integers", () => {
    assert.strictEqual(parseInt32("42"), 42);
    assert.strictEqual(parseInt32("-5"), -5);
    assert.strictEqual(parseInt32("2147483647"), 2147483647);
  });

  it("reinterprets unsigned 32-bit values as signed", () => {
    assert.strictEqual(parseInt32("4294967295"), -1);
    assert.strictEqual(parseInt32("4294967291"), -5);
    assert.strictEqual(parseInt32("2147483648"), -2147483648);
  });

  it("returns null for empty or non-numeric input", () => {
    assert.strictEqual(parseInt32(""), null);
    assert.strictEqual(parseInt32("abc"), null);
  });
});
