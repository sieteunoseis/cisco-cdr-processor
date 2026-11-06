const express = require("express");

const PROHIBITED_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXECUTE|EXEC|COPY)\b/i;

const SQL_COMMENT_RE = /--[^\n]*|\/\*[\s\S]*?\*\//g;

const MAX_ROWS = 10000;
const QUERY_TIMEOUT_MS = 30000;

function validateQuery(raw) {
  if (!raw || typeof raw !== "string") {
    return { valid: false, error: "Query is required" };
  }

  // Strip comments and trim
  const stripped = raw.replace(SQL_COMMENT_RE, " ").trim();
  if (!stripped) {
    return { valid: false, error: "Query is empty" };
  }

  // Must start with SELECT or WITH (for CTEs)
  const firstWord = stripped.split(/\s+/)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return { valid: false, error: "Only SELECT queries are allowed" };
  }

  // Check for prohibited keywords
  if (PROHIBITED_KEYWORDS.test(stripped)) {
    return { valid: false, error: "Query contains prohibited keywords" };
  }

  return { valid: true, query: raw.trim() };
}

function ensureLimit(query) {
  // Drop trailing semicolons so an appended LIMIT doesn't land after the
  // statement terminator ("...;\nLIMIT 10000" is a syntax error).
  const q = query.replace(/[\s;]+$/, "");
  // If query already has a LIMIT clause, leave it alone
  if (/\bLIMIT\s+\d+/i.test(q)) return q;
  return `${q}\nLIMIT ${MAX_ROWS}`;
}

function createSqlRouter(pool) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const { query } = req.body;
    const validation = validateQuery(query);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const limited = ensureLimit(validation.query);
    const start = Date.now();

    // Dedicated client so the timeout is enforced by Postgres itself
    // (node-pg's query_timeout only stops waiting; the backend kept running)
    // and so we can cancel the backend if the browser aborts the request.
    let client;
    let pid = null;
    let finished = false;
    const onClose = () => {
      if (!finished && pid) {
        pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
      }
    };
    res.on("close", onClose);

    try {
      client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);
      const result = await client.query(limited);

      const columns = result.fields.map((f) => f.name);
      res.json({
        columns,
        rows: result.rows,
        count: result.rows.length,
        duration_ms: Date.now() - start,
      });
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      // 57014 = query_canceled (statement_timeout or pg_cancel_backend)
      if (err.code === "57014") {
        return res
          .status(408)
          .json({
            error: `Query timed out (${QUERY_TIMEOUT_MS / 1000}s limit)`,
          });
      }
      res.status(500).json({ error: err.message });
    } finally {
      finished = true;
      res.off("close", onClose);
      if (client) {
        client
          .query("RESET statement_timeout")
          .catch(() => {})
          .finally(() => client.release());
      }
    }
  });

  // Schema endpoint for autocomplete
  router.get("/schema", async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`,
      );
      const tables = {};
      for (const row of result.rows) {
        if (!tables[row.table_name]) tables[row.table_name] = [];
        tables[row.table_name].push({
          name: row.column_name,
          type: row.data_type,
        });
      }
      res.json({ tables });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSqlRouter, validateQuery, ensureLimit };
