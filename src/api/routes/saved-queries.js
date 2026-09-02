// src/api/routes/saved-queries.js
const express = require("express");

function validatePayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Query payload required" };
  }
  const { name, query } = body;
  if (typeof name !== "string" || !name.trim()) {
    return { valid: false, error: "name is required" };
  }
  if (typeof query !== "string" || !query.trim()) {
    return { valid: false, error: "query is required" };
  }
  return { valid: true, rule: { name: name.trim(), query } };
}

function serialize(row) {
  return {
    id: String(row.id),
    name: row.name,
    query: row.query,
    createdAt: row.created_at,
  };
}

function createSavedQueriesRouter(pool) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM saved_queries ORDER BY created_at ASC, id ASC",
      );
      res.json({ queries: result.rows.map(serialize) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", async (req, res) => {
    const validation = validatePayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      const { name, query } = validation.rule;
      const result = await pool.query(
        `INSERT INTO saved_queries (name, query) VALUES ($1, $2) RETURNING *`,
        [name, query],
      );
      res.status(201).json({ query: serialize(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const existing = await pool.query(
        "SELECT * FROM saved_queries WHERE id = $1",
        [id],
      );
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: "Query not found" });
      }
      const current = serialize(existing.rows[0]);
      const merged = { ...current, ...req.body };
      const validation = validatePayload(merged);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const { name, query } = validation.rule;
      const result = await pool.query(
        `UPDATE saved_queries SET name = $1, query = $2 WHERE id = $3 RETURNING *`,
        [name, query, id],
      );
      res.json({ query: serialize(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM saved_queries WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Query not found" });
      }
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSavedQueriesRouter };
