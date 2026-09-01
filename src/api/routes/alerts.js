// src/api/routes/alerts.js
const express = require("express");
const { parseTimeRange } = require("../../database/queries");

const VALID_TYPES = [
  "volume_spike",
  "failure_rate",
  "label_volume",
  "long_call",
];
const LOOKBACK_RE = /^\d+[mhdw]$/;

// Maps a label rule's `fields` entries to the cdr columns they match
// against — same mapping the frontend's matchLabelRules uses, kept in
// sync so label_volume rules match the exact same calls a label badge
// would show.
const LABEL_FIELD_COLUMNS = {
  calling: "callingpartynumber",
  called: "finalcalledpartynumber",
  origDevice: "origdevicename",
  destDevice: "destdevicename",
};

const VALID_DIRECTIONS = ["above", "below"];
// Types whose label_id is an optional scope filter rather than a required
// selector — volume_spike/failure_rate run org-wide unless scoped.
const LABEL_SCOPABLE_TYPES = ["volume_spike", "failure_rate"];

function validateRulePayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Rule payload required" };
  }
  const { name, type, window, threshold, enabled, labelId, direction } = body;

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
  const directionVal =
    direction === undefined || direction === null ? "above" : direction;
  if (!VALID_DIRECTIONS.includes(directionVal)) {
    return {
      valid: false,
      error: `direction must be one of: ${VALID_DIRECTIONS.join(", ")}`,
    };
  }
  let labelIdNum = null;
  if (type === "label_volume") {
    labelIdNum = Number(labelId);
    if (!Number.isInteger(labelIdNum) || labelIdNum <= 0) {
      return {
        valid: false,
        error: "labelId is required for label_volume rules",
      };
    }
  } else if (LABEL_SCOPABLE_TYPES.includes(type) && labelId) {
    // Optional scope — only validate the shape if one was actually given.
    labelIdNum = Number(labelId);
    if (!Number.isInteger(labelIdNum) || labelIdNum <= 0) {
      return { valid: false, error: "labelId must be a valid label id" };
    }
  }

  return {
    valid: true,
    rule: {
      name: name.trim(),
      type,
      window,
      threshold: thresholdNum,
      enabled: enabled === undefined ? true : !!enabled,
      labelId: labelIdNum,
      direction: directionVal,
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
    labelId: row.label_id ? String(row.label_id) : null,
    direction: row.direction,
    createdAt: row.created_at,
  };
}

// Fetches the referenced label_rules row and builds an OR'd regex-match
// clause across its selected fields (calling ~* $1 OR called ~* $1 ...),
// matching matchLabelRules' OR-across-fields semantics on the frontend.
// Postgres's ~* is POSIX ERE rather than JS's regex dialect, but the
// simple alternation/anchor/char-class patterns this app's labels use
// (e.g. ^9?011, ^(211|311|411)$) are compatible with both.
async function loadLabelMatchClause(pool, labelId) {
  const result = await pool.query("SELECT * FROM label_rules WHERE id = $1", [
    labelId,
  ]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const columns = row.fields
    .map((f) => LABEL_FIELD_COLUMNS[f])
    .filter(Boolean);
  if (columns.length === 0) return null;
  return {
    label: row.label,
    pattern: row.pattern,
    clause: columns.map((c) => `${c} ~* $1`).join(" OR "),
  };
}

// Evaluates one enabled rule against live CDR data. volume_spike compares
// the current window's call count to the window immediately before it
// (no multi-day baseline — deliberately simple). failure_rate is an
// absolute threshold: % of calls in the window with a non-"normal
// clearing" (16) disconnect cause, matching the definition statsCdr's
// "volume" stat already uses for normal_calls/failed_calls. label_volume
// counts calls matching an existing label (International, Toll, N11,
// etc.) against a plain count threshold. long_call flags any call in the
// window longer than a duration threshold, in seconds.
async function evaluateRule(pool, rule) {
  const interval = parseTimeRange(rule.window);

  if (rule.type === "label_volume") {
    const match = await loadLabelMatchClause(pool, rule.labelId);
    if (!match) {
      // Label was deleted or has no matchable fields — nothing to evaluate.
      return { ...rule, triggered: false, current: 0, baseline: 0, value: null };
    }
    const result = await pool.query(
      `
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE ${match.clause}) AS matched
        FROM cdr
        WHERE datetimeorigination >= now() - interval '${interval}'
      `,
      [match.pattern],
    );
    const total = parseInt(result.rows[0].total, 10);
    const matched = parseInt(result.rows[0].matched, 10);
    return {
      ...rule,
      triggered:
        rule.direction === "below"
          ? matched <= rule.threshold
          : matched >= rule.threshold,
      current: matched,
      baseline: total,
      value: matched,
      labelName: match.label,
    };
  }

  if (rule.type === "long_call") {
    const result = await pool.query(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE EXTRACT(EPOCH FROM duration) > ${rule.threshold}) AS over_count,
        max(EXTRACT(EPOCH FROM duration)) AS max_duration
      FROM cdr
      WHERE datetimeorigination >= now() - interval '${interval}'
    `);
    const total = parseInt(result.rows[0].total, 10);
    const overCount = parseInt(result.rows[0].over_count, 10);
    const maxDuration = result.rows[0].max_duration;
    return {
      ...rule,
      triggered: overCount > 0,
      current: overCount,
      baseline: total,
      value: maxDuration !== null ? Math.round(Number(maxDuration)) : null,
    };
  }

  if (rule.type === "volume_spike") {
    let match = null;
    if (rule.labelId) match = await loadLabelMatchClause(pool, rule.labelId);
    const scopeClause = match ? `AND (${match.clause})` : "";
    const params = match ? [match.pattern] : [];
    const result = await pool.query(
      `
        SELECT
          count(*) FILTER (WHERE datetimeorigination >= now() - interval '${interval}') AS current_count,
          count(*) FILTER (
            WHERE datetimeorigination >= now() - interval '${interval}' * 2
              AND datetimeorigination < now() - interval '${interval}'
          ) AS prior_count
        FROM cdr
        WHERE true ${scopeClause}
      `,
      params,
    );
    const current = parseInt(result.rows[0].current_count, 10);
    const prior = parseInt(result.rows[0].prior_count, 10);
    const ratio = prior > 0 ? current / prior : current > 0 ? Infinity : 0;
    const triggered =
      rule.direction === "below"
        ? prior > 0 && ratio <= rule.threshold
        : prior > 0
          ? ratio >= rule.threshold
          : current > 0;
    return {
      ...rule,
      triggered,
      current,
      baseline: prior,
      value: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
      labelName: match ? match.label : null,
    };
  }

  // failure_rate
  let match = null;
  if (rule.labelId) match = await loadLabelMatchClause(pool, rule.labelId);
  const scopeClause = match ? `AND (${match.clause})` : "";
  const params = match ? [match.pattern] : [];
  const result = await pool.query(
    `
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE destcause_value != 16) AS failed
      FROM cdr
      WHERE datetimeorigination >= now() - interval '${interval}' ${scopeClause}
    `,
    params,
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
    labelName: match ? match.label : null,
  };
}

// Top calling/called numbers behind a rule's current trigger. volume_spike
// ranks by (current window count - prior window count) — the numbers
// actually driving the change, not just the numbers that are always busy
// (ascending for a "below"/drop rule, so the biggest decreases sort
// first). failure_rate ranks by raw failed-call count — a number with a
// 100% failure rate on 2 calls matters less than one with 50 failures.
// label_volume ranks by raw match count within the label's own matched
// set. `labelMatch` (from loadLabelMatchClause) is required for
// label_volume and an optional scope filter for volume_spike/failure_rate.
async function breakdownByColumn(pool, column, rule, interval, labelMatch) {
  if (rule.type === "label_volume") {
    const result = await pool.query(
      `
        SELECT ${column} AS number, count(*) AS count
        FROM cdr
        WHERE datetimeorigination >= now() - interval '${interval}'
          AND (${labelMatch.clause})
          AND ${column} IS NOT NULL
        GROUP BY ${column}
        ORDER BY count DESC
        LIMIT 10
      `,
      [labelMatch.pattern],
    );
    return result.rows.map((r) => ({
      number: r.number,
      count: parseInt(r.count, 10),
    }));
  }

  if (rule.type === "volume_spike") {
    const scopeClause = labelMatch ? `AND (${labelMatch.clause})` : "";
    const params = labelMatch ? [labelMatch.pattern] : [];
    const order = rule.direction === "below" ? "ASC" : "DESC";
    const result = await pool.query(
      `
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
            ${scopeClause}
          GROUP BY ${column}
        ) x
        WHERE current > 0 OR prior > 0
        ORDER BY delta ${order}
        LIMIT 10
      `,
      params,
    );
    return result.rows.map((r) => ({
      number: r.number,
      current: parseInt(r.current, 10),
      prior: parseInt(r.prior, 10),
      delta: parseInt(r.delta, 10),
    }));
  }

  // failure_rate
  {
    const scopeClause = labelMatch ? `AND (${labelMatch.clause})` : "";
    const params = labelMatch ? [labelMatch.pattern] : [];
    const result = await pool.query(
      `
        SELECT number, total, failed, ROUND(failed::numeric / total * 100, 1) AS rate
        FROM (
          SELECT ${column} AS number,
            count(*) AS total,
            count(*) FILTER (WHERE destcause_value != 16) AS failed
          FROM cdr
          WHERE datetimeorigination >= now() - interval '${interval}'
            AND ${column} IS NOT NULL
            ${scopeClause}
          GROUP BY ${column}
        ) x
        WHERE failed > 0
        ORDER BY failed DESC
        LIMIT 10
      `,
      params,
    );
    return result.rows.map((r) => ({
      number: r.number,
      total: parseInt(r.total, 10),
      failed: parseInt(r.failed, 10),
      rate: Number(r.rate),
    }));
  }
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
      const { name, type, window, threshold, enabled, labelId, direction } =
        validation.rule;
      const result = await pool.query(
        `INSERT INTO alert_rules (name, type, lookback, threshold, enabled, label_id, direction)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [name, type, window, threshold, enabled, labelId, direction],
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
      const { name, type, window, threshold, enabled, labelId, direction } =
        validation.rule;
      const result = await pool.query(
        `UPDATE alert_rules
         SET name = $1, type = $2, lookback = $3, threshold = $4, enabled = $5, label_id = $6, direction = $7
         WHERE id = $8 RETURNING *`,
        [name, type, window, threshold, enabled, labelId, direction, id],
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

      if (rule.type === "long_call") {
        const result = await pool.query(`
          SELECT
            callingpartynumber, finalcalledpartynumber,
            EXTRACT(EPOCH FROM duration) AS duration_seconds,
            datetimeorigination, globalcallid_callid, globalcallid_callmanagerid
          FROM cdr
          WHERE datetimeorigination >= now() - interval '${interval}'
            AND EXTRACT(EPOCH FROM duration) > ${rule.threshold}
          ORDER BY duration DESC
          LIMIT 10
        `);
        return res.json({
          calls: result.rows.map((r) => ({
            callingNumber: r.callingpartynumber,
            calledNumber: r.finalcalledpartynumber,
            durationSeconds: Math.round(Number(r.duration_seconds)),
            datetimeOrigination: r.datetimeorigination,
            callId: String(r.globalcallid_callid),
            callManagerId: String(r.globalcallid_callmanagerid),
          })),
        });
      }

      let labelMatch = null;
      if (rule.labelId) {
        labelMatch = await loadLabelMatchClause(pool, rule.labelId);
        if (!labelMatch && rule.type === "label_volume") {
          return res.json({ byCalling: [], byCalled: [] });
        }
      }

      const [byCalling, byCalled] = await Promise.all([
        breakdownByColumn(pool, "callingpartynumber", rule, interval, labelMatch),
        breakdownByColumn(
          pool,
          "finalcalledpartynumber",
          rule,
          interval,
          labelMatch,
        ),
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
