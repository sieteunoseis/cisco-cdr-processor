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
  // If query already has a LIMIT clause, leave it alone
  if (/\bLIMIT\s+\d+/i.test(query)) return query;
  return `${query}\nLIMIT ${MAX_ROWS}`;
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

    try {
      const result = await pool.query({
        text: limited,
        query_timeout: QUERY_TIMEOUT_MS,
      });

      const columns = result.fields.map((f) => f.name);
      const durationMs = Date.now() - start;

      res.json({
        columns,
        rows: result.rows,
        count: result.rows.length,
        duration_ms: durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      if (durationMs >= QUERY_TIMEOUT_MS - 1000) {
        return res.status(408).json({ error: "Query timed out (30s limit)" });
      }
      res.status(500).json({ error: err.message });
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

module.exports = { createSqlRouter, validateQuery };
