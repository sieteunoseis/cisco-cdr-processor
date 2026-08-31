const { describe, it } = require("node:test");
const assert = require("node:assert");
const { validateRulePayload } = require("../../src/api/routes/labels");

describe("label rule validation", () => {
  it("accepts a well-formed rule", () => {
    const result = validateRulePayload({
      label: "Analog",
      color: "yellow",
      fields: ["origDevice", "destDevice"],
      pattern: "^(ATA|AN[0-9A-F])",
      enabled: true,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.rule.label, "Analog");
    assert.strictEqual(result.rule.enabled, true);
  });

  it("defaults enabled to true when omitted", () => {
    const result = validateRulePayload({
      label: "Test",
      color: "blue",
      fields: ["called"],
      pattern: "^123$",
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.rule.enabled, true);
  });

  it("rejects a missing label", () => {
    const result = validateRulePayload({
      color: "blue",
      fields: ["called"],
      pattern: "^123$",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /label/);
  });

  it("rejects a missing pattern", () => {
    const result = validateRulePayload({
      label: "Test",
      color: "blue",
      fields: ["called"],
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /pattern/);
  });

  it("rejects an invalid color", () => {
    const result = validateRulePayload({
      label: "Test",
      color: "magenta",
      fields: ["called"],
      pattern: "^123$",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /color/);
  });

  it("rejects an empty fields array", () => {
    const result = validateRulePayload({
      label: "Test",
      color: "blue",
      fields: [],
      pattern: "^123$",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /fields/);
  });

  it("rejects an unknown field name", () => {
    const result = validateRulePayload({
      label: "Test",
      color: "blue",
      fields: ["callingParty"],
      pattern: "^123$",
    });
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /fields/);
  });

  it("rejects a non-object payload", () => {
    const result = validateRulePayload(null);
    assert.strictEqual(result.valid, false);
  });
});
