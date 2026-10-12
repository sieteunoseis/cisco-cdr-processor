const { describe, it } = require("node:test");
const assert = require("node:assert");
const pool = require("../../src/database/pool");

describe("pool", () => {
  it("pins the session timezone to the Node process timezone", () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.strictEqual(pool.options.options, `-c timezone=${tz}`);
  });
});
