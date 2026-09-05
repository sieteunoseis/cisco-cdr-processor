const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  extractNpaNxx,
  collectNumberPrefixes,
  mapCarrierToRecords,
  CARRIER_FIELDS,
} = require("../../src/enrichment/carrier");

describe("carrier - extractNpaNxx", () => {
  it("extracts the 6-digit NPA-NXX from a 10-digit number", () => {
    assert.strictEqual(extractNpaNxx("5034185603"), "503418");
  });

  it("extracts the 6-digit NPA-NXX from an 11-digit number with leading 1", () => {
    assert.strictEqual(extractNpaNxx("15034185603"), "503418");
  });

  it("strips non-digit formatting before extracting", () => {
    assert.strictEqual(extractNpaNxx("+1 (503) 418-5603"), "503418");
  });

  it("returns null for a short internal extension", () => {
    assert.strictEqual(extractNpaNxx("4185"), null);
  });

  it("returns null for null/empty input", () => {
    assert.strictEqual(extractNpaNxx(null), null);
    assert.strictEqual(extractNpaNxx(""), null);
    assert.strictEqual(extractNpaNxx(undefined), null);
  });
});

describe("carrier - collectNumberPrefixes", () => {
  it("collects unique prefixes across all carrier fields", () => {
    const records = [
      { callingpartynumber: "5034185603", finalcalledpartynumber: "5034185603" },
      { callingpartynumber: "9712223333" },
    ];
    const prefixes = collectNumberPrefixes(records);
    assert.deepStrictEqual([...prefixes].sort(), ["503418", "971222"]);
  });

  it("ignores non-NANP values like short extensions", () => {
    const records = [{ callingpartynumber: "4185" }];
    assert.strictEqual(collectNumberPrefixes(records).size, 0);
  });
});

describe("carrier - mapCarrierToRecords", () => {
  it("stamps <field>_carrier onto records with a matching prefix", () => {
    const records = [
      {
        callingpartynumber: "5034185603",
        originalcalledpartynumber: "9712223333",
      },
    ];
    const carrierMap = new Map([
      ["503418", "CENTURYLINK"],
      ["971222", "T-MOBILE USA"],
    ]);
    const result = mapCarrierToRecords(records, carrierMap);
    assert.strictEqual(result[0].callingpartynumber_carrier, "CENTURYLINK");
    assert.strictEqual(
      result[0].originalcalledpartynumber_carrier,
      "T-MOBILE USA",
    );
  });

  it("leaves <field>_carrier unset when the prefix has no match", () => {
    const records = [{ callingpartynumber: "5034185603" }];
    const result = mapCarrierToRecords(records, new Map());
    assert.strictEqual(result[0].callingpartynumber_carrier, undefined);
  });

  it("leaves <field>_carrier unset when the source field isn't a NANP number", () => {
    const records = [{ callingpartynumber: "4185" }];
    const carrierMap = new Map([["503418", "CENTURYLINK"]]);
    const result = mapCarrierToRecords(records, carrierMap);
    assert.strictEqual(result[0].callingpartynumber_carrier, undefined);
  });

  it("covers all four CARRIER_FIELDS by default", () => {
    assert.deepStrictEqual(CARRIER_FIELDS, [
      "callingpartynumber",
      "originalcalledpartynumber",
      "finalcalledpartynumber",
      "lastredirectdn",
    ]);
  });
});
