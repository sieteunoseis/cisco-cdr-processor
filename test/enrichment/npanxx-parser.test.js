const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  parseNpanxxLine,
  parseNpanxxFile,
} = require("../../src/enrichment/npanxx-parser");

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "../fixtures/sample_npanxx.txt"),
  "utf8",
);

describe("npanxx-parser - parseNpanxxLine", () => {
  it("parses an assigned (AS) row into a record", () => {
    const line =
      'AK   \t907-200\t6872\t"GCI COMMUNICATION CORP. DBA GENERAL COMMUNICATION"                                                 \tVALDEZ    \t             \tAS \t02/21/2006   \tI             \tN           \tYes';
    const record = parseNpanxxLine(line);
    assert.deepStrictEqual(record, {
      prefix: "907200",
      state: "AK",
      rateCenter: "VALDEZ",
      company: "GCI COMMUNICATION CORP. DBA GENERAL COMMUNICATION",
      ocn: "6872",
      assignDate: "2006-02-21",
      use: "AS",
    });
  });

  it("returns null assignDate when the field is blank", () => {
    const line =
      'AK   \t907-221\t3023\t"UNITED UTILITIES, INC."                                                                            \tBIRCHCREEK\t             \tAS \t             \t              \tN           \tYes';
    const record = parseNpanxxLine(line);
    assert.strictEqual(record.assignDate, null);
  });

  it("returns null for the header row", () => {
    const line =
      "State\tNPA-NXX\tOCN \tCompany                                                                                             \tRateCenter\tEffectiveDate\tUse\tAssignDate   \tInitial/Growth\tPooled Code \tIn Service  \tFile Updated 09/04/2026";
    assert.strictEqual(parseNpanxxLine(line), null);
  });

  it("returns null for a blank line", () => {
    assert.strictEqual(parseNpanxxLine(""), null);
  });
});

describe("npanxx-parser - parseNpanxxFile", () => {
  it("parses only assigned (AS) rows from the full file, skipping the header and unassigned rows", () => {
    const records = parseNpanxxFile(FIXTURE);
    assert.deepStrictEqual(
      records.map((r) => r.prefix),
      ["907200", "907201", "907221"],
    );
    assert.ok(records.every((r) => r.use === "AS"));
  });

  it("strips the NPA-NXX dash to build a 6-digit prefix", () => {
    const records = parseNpanxxFile(FIXTURE);
    assert.strictEqual(records[1].prefix, "907201");
    assert.strictEqual(records[1].company, "CELLCO PARTNERSHIP DBA VERIZON WIRELESS");
  });
});
