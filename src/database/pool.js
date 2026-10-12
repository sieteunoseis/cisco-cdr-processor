const { Pool } = require("pg");
const config = require("../config");

// cdr/cmr timestamps are `timestamp without time zone`. pg serializes JS
// Dates with the Node process's UTC offset and Postgres drops it, so the
// stored values are Node-local wall-clock time. Pin each session's TimeZone
// to Node's so now()/timestamptz comparisons line up with those values
// instead of shifting by the database server's offset.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pool = new Pool({
  connectionString: config.database.url,
  options: `-c timezone=${timeZone}`,
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err.message);
});

module.exports = pool;
