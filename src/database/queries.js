const fs = require("fs");

// Helper: parse "30m", "2h", "1d", "7d" to Postgres interval string
function parseTimeRange(last) {
  const match = (last || "24h").match(/^(\d+)([mhdw])$/);
  if (!match) return "24 hours";
  const [, num, unit] = match;
  const units = { m: "minutes", h: "hours", d: "days", w: "weeks" };
  return `${num} ${units[unit] || "hours"}`;
}

// Enrichment columns to include in SELECT
const ENRICHMENT_COLS = `
  c.orig_device_description,
  c.orig_device_user,
  c.orig_device_pool,
  c.orig_device_location,
  c.orig_device_type,
  c.orig_device_model,
  c.dest_device_description,
  c.dest_device_user,
  c.dest_device_pool,
  c.dest_device_location,
  c.dest_device_type,
  c.dest_device_model,
  c.calling_party_user,
  c.called_party_user,
  c.route_pattern_matched,
  c.enriched_at`;

async function searchCdr(pool, params) {
  const {
    calling,
    called,
    number,
    device,
    cause,
    last,
    start,
    end,
    limit = 100,
  } = params;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (number) {
    conditions.push(
      `(c.callingpartynumber LIKE $${idx} OR c.finalcalledpartynumber LIKE $${idx} OR c.originalcalledpartynumber LIKE $${idx})`,
    );
    values.push(`%${number}%`);
    idx++;
  }
  if (calling) {
    conditions.push(`c.callingpartynumber LIKE $${idx++}`);
    values.push(`%${calling}%`);
  }
  if (called) {
    conditions.push(`c.finalcalledpartynumber LIKE $${idx++}`);
    values.push(`%${called}%`);
  }
  if (device) {
    conditions.push(
      `(c.origdevicename LIKE $${idx} OR c.destdevicename LIKE $${idx})`,
    );
    values.push(`%${device}%`);
    idx++;
  }
  if (cause) {
    conditions.push(
      `(c.origcause_value = $${idx} OR c.destcause_value = $${idx})`,
    );
    values.push(parseInt(cause, 10));
    idx++;
  }
  if (start) {
    conditions.push(`c.datetimeorigination >= $${idx++}`);
    values.push(start);
  }
  if (end) {
    conditions.push(`c.datetimeorigination <= $${idx++}`);
    values.push(end);
  }
  if (!start && !end && last) {
    conditions.push(
      `c.datetimeorigination >= now() - interval '${parseTimeRange(last)}'`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitVal = Math.min(parseInt(limit, 10) || 100, 1000);

  const sql = `
    SELECT
      c.pkid,
      c.globalcallid_clusterid,
      c.globalcallid_callmanagerid,
      c.globalcallid_callid,
      c.callingpartynumber,
      c.finalcalledpartynumber,
      c.originalcalledpartynumber,
      c.origdevicename,
      c.destdevicename,
      c.datetimeorigination,
      c.datetimeconnect,
      c.datetimedisconnect,
      c.duration,
      c.origcause_value,
      oc.description AS origcause_description,
      c.destcause_value,
      dc.description AS destcause_description,
      c.origmediacap_payloadcapability,
      codec.description AS orig_codec_description,
      c.callsecuredstatus,
      c.lastredirectdn,
      c.lastredirectredirectreason,
      c.origcalledpartyredirectreason,
      c.origcallterminationonbehalfof,
      c.destcallterminationonbehalfof,
      c.joinonbehalfof,
      ${ENRICHMENT_COLS}
    FROM cdr c
    LEFT JOIN cdr_cause oc ON c.origcause_value = oc.id
    LEFT JOIN cdr_cause dc ON c.destcause_value = dc.id
    LEFT JOIN cdr_codec codec ON c.origmediacap_payloadcapability = codec.id
    ${where}
    ORDER BY c.datetimeorigination DESC
    LIMIT ${limitVal}
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

async function traceCdr(pool, callId, callManagerId) {
  const cdrConditions = ["c.globalcallid_callid = $1"];
  const cdrValues = [callId];
  const cmrConditions = ["m.globalcallid_callid = $1"];
  const cmrValues = [callId];

  if (callManagerId) {
    cdrConditions.push("c.globalcallid_callmanagerid = $2");
    cdrValues.push(callManagerId);
    cmrConditions.push("m.globalcallid_callmanagerid = $2");
    cmrValues.push(callManagerId);
  }

  const cdrSql = `
    SELECT
      c.*,
      oc.description AS origcause_description,
      dc.description AS destcause_description,
      codec.description AS orig_codec_description
    FROM cdr c
    LEFT JOIN cdr_cause oc ON c.origcause_value = oc.id
    LEFT JOIN cdr_cause dc ON c.destcause_value = dc.id
    LEFT JOIN cdr_codec codec ON c.origmediacap_payloadcapability = codec.id
    WHERE ${cdrConditions.join(" AND ")}
    ORDER BY c.datetimeorigination ASC
  `;

  const cmrSql = `
    SELECT m.*
    FROM cmr m
    WHERE ${cmrConditions.join(" AND ")}
    ORDER BY m.datetimestamp ASC
  `;

  const [cdrResult, cmrResult] = await Promise.all([
    pool.query(cdrSql, cdrValues),
    pool.query(cmrSql, cmrValues),
  ]);

  const cdrRows = cdrResult.rows;

  let sdlTraceCommand = null;
  if (cdrRows.length > 0) {
    const origTimes = cdrRows
      .map((r) => r.datetimeorigination)
      .filter(Boolean)
      .map((t) => new Date(t).getTime());
    const discTimes = cdrRows
      .map((r) => r.datetimedisconnect)
      .filter(Boolean)
      .map((t) => new Date(t).getTime());

    if (origTimes.length && discTimes.length) {
      const traceStart = new Date(Math.min(...origTimes) - 30000).toISOString();
      const traceEnd = new Date(Math.max(...discTimes) + 30000).toISOString();
      sdlTraceCommand = `cisco-dime select "Cisco CallManager" --start "${traceStart}" --end "${traceEnd}" --download --decompress`;
    }
  }

  return {
    cdr: cdrRows,
    cmr: cmrResult.rows,
    sdl_trace_command: sdlTraceCommand,
  };
}

async function qualityCdr(pool, params) {
  const {
    mos_below,
    jitter_above,
    latency_above,
    loss_above,
    last,
    start,
    end,
    limit = 100,
  } = params;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (mos_below != null) {
    conditions.push(`m.moslqk < $${idx++}`);
    values.push(parseFloat(mos_below));
  }
  if (jitter_above != null) {
    conditions.push(`m.jitter > $${idx++}`);
    values.push(parseInt(jitter_above, 10));
  }
  if (latency_above != null) {
    conditions.push(`m.latency > $${idx++}`);
    values.push(parseInt(latency_above, 10));
  }
  if (loss_above != null) {
    conditions.push(`m.numberpacketslost > $${idx++}`);
    values.push(parseInt(loss_above, 10));
  }
  if (start) {
    conditions.push(`c.datetimeorigination >= $${idx++}`);
    values.push(start);
  }
  if (end) {
    conditions.push(`c.datetimeorigination <= $${idx++}`);
    values.push(end);
  }
  if (!start && !end) {
    conditions.push(
      `c.datetimeorigination >= now() - interval '${parseTimeRange(last)}'`,
    );
  }

  // Default: show poor quality calls even if no threshold specified
  if (!mos_below && !jitter_above && !latency_above && !loss_above) {
    conditions.push(`m.moslqk < $${idx++}`);
    values.push(3.5);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limitVal = Math.min(parseInt(limit, 10) || 100, 1000);

  const sql = `
    SELECT
      c.pkid,
      c.globalcallid_clusterid,
      c.globalcallid_callmanagerid,
      c.globalcallid_callid,
      c.callingpartynumber,
      c.finalcalledpartynumber,
      c.origdevicename,
      c.destdevicename,
      c.datetimeorigination,
      c.duration,
      c.origcause_value,
      m.devicename AS cmr_devicename,
      m.directorynum,
      m.moslqk,
      m.moslqkavg,
      m.moslqkmin,
      m.moslqkmax,
      m.jitter,
      m.latency,
      m.numberpacketslost,
      m.numberpacketssent,
      m.intervalconcealratio,
      m.cumulativeconcealratio,
      ${ENRICHMENT_COLS}
    FROM cdr c
    JOIN cmr m
      ON c.globalcallid_callmanagerid = m.globalcallid_callmanagerid
      AND c.globalcallid_callid = m.globalcallid_callid
    ${where}
    ORDER BY m.moslqk ASC NULLS LAST
    LIMIT ${limitVal}
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

async function statsCdr(pool, params) {
  const {
    type,
    last,
    start,
    end,
    limit = 20,
    interval: groupInterval = "hour",
  } = params;

  const timeConditions = [];
  const timeValues = [];
  let idx = 1;

  if (start) {
    timeConditions.push(`datetimeorigination >= $${idx++}`);
    timeValues.push(start);
  }
  if (end) {
    timeConditions.push(`datetimeorigination <= $${idx++}`);
    timeValues.push(end);
  }
  if (!start && !end) {
    timeConditions.push(
      `datetimeorigination >= now() - interval '${parseTimeRange(last)}'`,
    );
  }

  const timeWhere = timeConditions.length
    ? `WHERE ${timeConditions.join(" AND ")}`
    : "";
  const limitVal = Math.min(parseInt(limit, 10) || 20, 500);

  let sql;
  let values = timeValues;

  switch (type) {
    case "volume": {
      const validIntervals = ["minute", "hour", "day", "week", "month"];
      const trunc = validIntervals.includes(groupInterval)
        ? groupInterval
        : "hour";
      sql = `
        SELECT
          date_trunc('${trunc}', datetimeorigination) AS period,
          count(*) AS call_count,
          avg(duration) AS avg_duration_seconds,
          sum(CASE WHEN destcause_value = 16 THEN 1 ELSE 0 END) AS normal_calls,
          sum(CASE WHEN destcause_value != 16 THEN 1 ELSE 0 END) AS failed_calls
        FROM cdr
        ${timeWhere}
        GROUP BY date_trunc('${trunc}', datetimeorigination)
        ORDER BY period ASC
      `;
      break;
    }

    case "top_callers": {
      sql = `
        SELECT
          callingpartynumber,
          count(*) AS call_count,
          sum(duration) AS total_duration_seconds,
          avg(duration) AS avg_duration_seconds
        FROM cdr
        ${timeWhere}
        GROUP BY callingpartynumber
        ORDER BY call_count DESC
        LIMIT ${limitVal}
      `;
      break;
    }

    case "top_called": {
      sql = `
        SELECT
          finalcalledpartynumber,
          count(*) AS call_count,
          sum(duration) AS total_duration_seconds,
          avg(duration) AS avg_duration_seconds
        FROM cdr
        ${timeWhere}
        GROUP BY finalcalledpartynumber
        ORDER BY call_count DESC
        LIMIT ${limitVal}
      `;
      break;
    }

    case "by_cause": {
      sql = `
        SELECT
          c.destcause_value,
          cc.description AS cause_description,
          count(*) AS call_count
        FROM cdr c
        LEFT JOIN cdr_cause cc ON c.destcause_value = cc.id
        ${timeWhere.replace("datetimeorigination", "c.datetimeorigination")}
        GROUP BY c.destcause_value, cc.description
        ORDER BY call_count DESC
        LIMIT ${limitVal}
      `;
      break;
    }

    case "by_device": {
      sql = `
        SELECT
          origdevicename AS device_name,
          orig_device_description,
          orig_device_pool,
          orig_device_location,
          count(*) AS call_count,
          avg(duration) AS avg_duration_seconds,
          sum(CASE WHEN destcause_value != 16 THEN 1 ELSE 0 END) AS failed_calls
        FROM cdr
        ${timeWhere}
        GROUP BY origdevicename, orig_device_description, orig_device_pool, orig_device_location
        ORDER BY call_count DESC
        LIMIT ${limitVal}
      `;
      break;
    }

    case "by_location": {
      sql = `
        SELECT
          orig_device_pool,
          orig_device_location,
          count(*) AS call_count,
          avg(duration) AS avg_duration_seconds,
          sum(CASE WHEN destcause_value != 16 THEN 1 ELSE 0 END) AS failed_calls,
          round(
            100.0 * sum(CASE WHEN destcause_value != 16 THEN 1 ELSE 0 END) / nullif(count(*), 0),
            2
          ) AS failure_rate_pct
        FROM cdr
        ${timeWhere}
        GROUP BY orig_device_pool, orig_device_location
        ORDER BY call_count DESC
        LIMIT ${limitVal}
      `;
      break;
    }

    default:
      throw new Error(
        `Unknown stats type: "${type}". Valid types: volume, top_callers, top_called, by_cause, by_device, by_location`,
      );
  }

  const result = await pool.query(sql, values);
  return result.rows;
}

async function healthCheck(pool, incomingDir) {
  const health = {};

  // CDR count + date range
  const cdrStats = await pool.query(`
    SELECT
      count(*) AS total,
      min(datetimeorigination) AS oldest,
      max(datetimeorigination) AS newest
    FROM cdr
  `);
  health.cdr = cdrStats.rows[0];

  // CMR count
  const cmrStats = await pool.query(`
    SELECT count(*) AS total FROM cmr
  `);
  health.cmr = { total: cmrStats.rows[0].total };

  // File processing log — last hour
  const recentFiles = await pool.query(`
    SELECT
      count(*) AS files_processed,
      sum(records_inserted) AS records_inserted,
      count(CASE WHEN error IS NOT NULL THEN 1 END) AS errors
    FROM file_processing_log
    WHERE processed_at >= now() - interval '1 hour'
  `);
  health.file_processing_last_hour = recentFiles.rows[0];

  // Enrichment cache stats
  const cacheStats = await pool.query(`
    SELECT
      count(*) AS total_entries,
      count(CASE WHEN expires_at < now() THEN 1 END) AS expired_entries
    FROM enrichment_cache
  `);
  health.enrichment_cache = cacheStats.rows[0];

  // Files in incoming directory
  try {
    const files = fs.readdirSync(incomingDir);
    health.incoming_files_pending = files.length;
  } catch (err) {
    health.incoming_files_pending = null;
    health.incoming_dir_error = err.message;
  }

  health.status = "ok";
  health.timestamp = new Date().toISOString();

  return health;
}

module.exports = {
  searchCdr,
  traceCdr,
  qualityCdr,
  statsCdr,
  healthCheck,
  parseTimeRange,
};
