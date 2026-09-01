// src/api/routes/alerts.js
const express = require("express");
const { parseTimeRange } = require("../../database/queries");

const VALID_TYPES = ["volume_spike", "failure_rate"];
const LOOKBACK_RE = /^\d+[mhdw]$/;

function validateRulePayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Rule payload required" };
  }
  const { name, type, window, threshold, enabled } = body;

  if (typeof name !== "string" || !name.trim()) {
    return { valid: false, error: "name is required" };
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type)) {
    return {
      valid: false,
      error: `type must be one of: ${VALID_TYPES.join(", ")}`,
    };
  }
  if (typeof window !== "string" || !LOOKBACK_RE.test(window)) {
    return {
      valid: false,
      error: "window must look like 15m, 1h, 1d, 1w",
    };
  }
  const thresholdNum = Number(threshold);
  if (!Number.isFinite(thresholdNum) || thresholdNum <= 0) {
    return { valid: false, error: "threshold must be a positive number" };
  }

  return {
    valid: true,
    rule: {
      name: name.trim(),
      type,
      window,
      threshold: thresholdNum,
      enabled: enabled === undefined ? true : !!enabled,
    },
  };
}

function serializeRule(row) {
  return {
    id: String(row.id),
    name: row.name,
    type: row.type,
    window: row.lookback,
    threshold: Number(row.threshold),
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

// Evaluates one enabled rule against live CDR data. volume_spike compares
// the current window's call count to the window immediately before it
// (no multi-day baseline — deliberately simple). failure_rate is an
// absolute threshold: % of calls in the window with a non-"normal
// clearing" (16) disconnect cause, matching the definition statsCdr's
// "volume" stat already uses for normal_calls/failed_calls.
async function evaluateRule(pool, rule) {
  const interval = parseTimeRange(rule.window);

  if (rule.type === "volume_spike") {
    const result = await pool.query(`
      SELECT
        count(*) FILTER (WHERE datetimeorigination >= now() - interval '${interval}') AS current_count,
        count(*) FILTER (
          WHERE datetimeorigination >= now() - interval '${interval}' * 2
            AND datetimeorigination < now() - interval '${interval}'
        ) AS prior_count
      FROM cdr
    `);
    const current = parseInt(result.rows[0].current_count, 10);
    const prior = parseInt(result.rows[0].prior_count, 10);
    const ratio = prior > 0 ? current / prior : current > 0 ? Infinity : 0;
    const triggered = prior > 0 ? ratio >= rule.threshold : current > 0;
    return {
      ...rule,
      triggered,
      current,
      baseline: prior,
      value: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
    };
  }

  // failure_rate
  const result = await pool.query(
    `
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE destcause_value != 16) AS failed
      FROM cdr
      WHERE datetimeorigination >= now() - interval '${interval}'
    `,
  );
  const total = parseInt(result.rows[0].total, 10);
  const failed = parseInt(result.rows[0].failed, 10);
  const pct = total > 0 ? (failed / total) * 100 : 0;
  return {
    ...rule,
    triggered: total > 0 && pct >= rule.threshold,
    current: failed,
    baseline: total,
    value: Number(pct.toFixed(1)),
  };
}

// Top calling/called numbers behind a rule's current trigger. volume_spike
// ranks by (current window count - prior window count) — the numbers
// actually driving the increase, not just the numbers that are always
// busy. failure_rate ranks by raw failed-call count — a number with a
// 100% failure rate on 2 calls matters less than one with 50 failures.
async function breakdownByColumn(pool, column, rule, interval) {
  if (rule.type === "volume_spike") {
    const result = await pool.query(`
      SELECT number, current, prior, (current - prior) AS delta
      FROM (
        SELECT ${column} AS number,
          count(*) FILTER (WHERE datetimeorigination >= now() - interval '${interval}') AS current,
          count(*) FILTER (
            WHERE datetimeorigination >= now() - interval '${interval}' * 2
              AND datetimeorigination < now() - interval '${interval}'
          ) AS prior
        FROM cdr
        WHERE datetimeorigination >= now() - interval '${interval}' * 2
          AND ${column} IS NOT NULL
        GROUP BY ${column}
      ) x
      WHERE current > 0
      ORDER BY delta DESC
      LIMIT 10
    `);
    return result.rows.map((r) => ({
      number: r.number,
      current: parseInt(r.current, 10),
      prior: parseInt(r.prior, 10),
      delta: parseInt(r.delta, 10),
    }));
  }

  // failure_rate
  const result = await pool.query(`
    SELECT number, total, failed, ROUND(failed::numeric / total * 100, 1) AS rate
    FROM (
      SELECT ${column} AS number,
        count(*) AS total,
        count(*) FILTER (WHERE destcause_value != 16) AS failed
      FROM cdr
      WHERE datetimeorigination >= now() - interval '${interval}'
        AND ${column} IS NOT NULL
      GROUP BY ${column}
    ) x
    WHERE failed > 0
    ORDER BY failed DESC
    LIMIT 10
  `);
  return result.rows.map((r) => ({
    number: r.number,
    total: parseInt(r.total, 10),
    failed: parseInt(r.failed, 10),
    rate: Number(r.rate),
  }));
}

function createAlertsRouter(pool) {
  const router = express.Router();

  router.get("/rules", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM alert_rules ORDER BY created_at ASC, id ASC",
      );
      res.json({ rules: result.rows.map(serializeRule) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/rules", async (req, res) => {
    const validation = validateRulePayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      const { name, type, window, threshold, enabled } = validation.rule;
      const result = await pool.query(
        `INSERT INTO alert_rules (name, type, lookback, threshold, enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, type, window, threshold, enabled],
      );
      res.status(201).json({ rule: serializeRule(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/rules/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const existing = await pool.query(
        "SELECT * FROM alert_rules WHERE id = $1",
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
      const { name, type, window, threshold, enabled } = validation.rule;
      const result = await pool.query(
        `UPDATE alert_rules
         SET name = $1, type = $2, lookback = $3, threshold = $4, enabled = $5
         WHERE id = $6 RETURNING *`,
        [name, type, window, threshold, enabled, id],
      );
      res.json({ rule: serializeRule(result.rows[0]) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/rules/:id", async (req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM alert_rules WHERE id = $1 RETURNING id",
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

  router.get("/rules/:id/breakdown", async (req, res) => {
    try {
      const existing = await pool.query(
        "SELECT * FROM alert_rules WHERE id = $1",
        [req.params.id],
      );
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: "Rule not found" });
      }
      const rule = serializeRule(existing.rows[0]);
      const interval = parseTimeRange(rule.window);
      const [byCalling, byCalled] = await Promise.all([
        breakdownByColumn(pool, "callingpartynumber", rule, interval),
        breakdownByColumn(pool, "finalcalledpartynumber", rule, interval),
      ]);
      res.json({ byCalling, byCalled });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/check", async (req, res) => {
    try {
      const rulesResult = await pool.query(
        "SELECT * FROM alert_rules WHERE enabled = true ORDER BY created_at ASC, id ASC",
      );
      const results = await Promise.all(
        rulesResult.rows.map((row) => evaluateRule(pool, serializeRule(row))),
      );
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAlertsRouter, validateRulePayload };
