const express = require("express");

const VALID_FIELDS = ["calling", "called", "origDevice", "destDevice"];
const VALID_COLORS = [
  "gray",
  "blue",
  "orange",
  "green",
  "red",
  "purple",
  "yellow",
];

function validateRulePayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Rule payload required" };
  }
  const { label, color, fields, pattern, enabled } = body;

  if (typeof label !== "string" || !label.trim()) {
    return { valid: false, error: "label is required" };
  }
  if (typeof pattern !== "string" || !pattern.trim()) {
    return { valid: false, error: "pattern is required" };
  }
  if (typeof color !== "string" || !VALID_COLORS.includes(color)) {
    return {
      valid: false,
      error: `color must be one of: ${VALID_COLORS.join(", ")}`,
    };
  }
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((f) => typeof f === "string" && VALID_FIELDS.includes(f))
  ) {
    return {
      valid: false,
      error: `fields must be a non-empty array of: ${VALID_FIELDS.join(", ")}`,
    };
  }

  return {
    valid: true,
    rule: {
      label: label.trim(),
      color,
      fields,
      pattern,
      enabled: enabled === undefined ? true : !!enabled,
    },
  };
}

function serializeRule(row) {
  return {
    id: String(row.id),
    label: row.label,
    color: row.color,
    fields: row.fields,
    pattern: row.pattern,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

const DEFAULT_SEED = [
  {
    label: "Analog",
    color: "yellow",
    fields: ["origDevice", "destDevice"],
    pattern: "^(ATA|AN[0-9A-F])",
    enabled: true,
  },
  {
    label: "Emergency",
    color: "red",
    fields: ["called"],
    pattern: "^(911|112|999|000|111)$",
    enabled: true,
  },
];

function createLabelsRouter(pool) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM label_rules ORDER BY created_at ASC",
      );
      res.json({ rules: result.rows.map(serializeRule) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", async (req, res) => {
    const validation = validateRulePayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      const { label, color, fields, pattern, enabled } = validation.rule;
      const result = await pool.query(
        `INSERT INTO label_rules (label, color, fields, pattern, enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [label, color, JSON.stringify(fields), pattern, enabled],
      );
      res.status(201).json({ rule: serializeRule(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/bulk", async (req, res) => {
    const { rules } = req.body || {};
    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({ error: "rules array required" });
    }

    const validated = [];
    for (const r of rules) {
      const validation = validateRulePayload(r);
      if (!validation.valid) {
        return res.status(400).json({
          error: `Invalid rule ("${r && r.label ? r.label : "unnamed"}"): ${validation.error}`,
        });
      }
      validated.push(validation.rule);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const rule of validated) {
        await client.query(
          `INSERT INTO label_rules (label, color, fields, pattern, enabled)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            rule.label,
            rule.color,
            JSON.stringify(rule.fields),
            rule.pattern,
            rule.enabled,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }

    const result = await pool.query(
      "SELECT * FROM label_rules ORDER BY created_at ASC",
    );
    res.json({
      imported: validated.length,
      rules: result.rows.map(serializeRule),
    });
  });

  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const existing = await pool.query(
        "SELECT * FROM label_rules WHERE id = $1",
        [id],
      );
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: "Rule not found" });
      }
      const current = serializeRule(existing.rows[0]);
      const merged = { ...current, ...req.body };
      const validation = validateRulePayload(merged);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const { label, color, fields, pattern, enabled } = validation.rule;
      const result = await pool.query(
        `UPDATE label_rules
         SET label = $1, color = $2, fields = $3, pattern = $4, enabled = $5
         WHERE id = $6 RETURNING *`,
        [label, color, JSON.stringify(fields), pattern, enabled, id],
      );
      res.json({ rule: serializeRule(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM label_rules WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/reset", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE label_rules RESTART IDENTITY");
      for (const rule of DEFAULT_SEED) {
        await client.query(
          `INSERT INTO label_rules (label, color, fields, pattern, enabled)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            rule.label,
            rule.color,
            JSON.stringify(rule.fields),
            rule.pattern,
            rule.enabled,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }

    const result = await pool.query(
      "SELECT * FROM label_rules ORDER BY created_at ASC",
    );
    res.json({ rules: result.rows.map(serializeRule) });
  });

  return router;
}

module.exports = { createLabelsRouter, validateRulePayload };
