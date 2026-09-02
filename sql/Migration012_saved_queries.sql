-- sql/Migration012_saved_queries.sql
-- Shared SQL queries (SQL page's "Saved Queries" list), replacing the
-- previous per-browser localStorage storage — same reasoning as
-- Migration005's label_rules: one global, team-visible set.
CREATE TABLE IF NOT EXISTS saved_queries (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO saved_queries (name, query)
SELECT * FROM (VALUES
  ('IPS/OIO — Calls by DN', $q$SELECT
  datetimeorigination, callingpartynumber, originalcalledpartynumber,
  finalcalledpartynumber, duration, origdevicename, destdevicename,
  origcause, destcause, origcodec
FROM cdr_augmented
WHERE datetimeorigination BETWEEN :start_date=Mar-01-2026 AND :end_date=Mar-26-2026
  AND datetimeconnect IS NOT NULL
  AND :dn=5034185603 IN (callingpartynumber, originalcalledpartynumber, finalcalledpartynumber)
ORDER BY datetimeorigination$q$),
  ('Calls for multiple DNs', $q$SELECT
  datetimeorigination, callingpartynumber, originalcalledpartynumber,
  finalcalledpartynumber, duration, origdevicename, destdevicename,
  origcause, destcause
FROM cdr_augmented
WHERE datetimeorigination BETWEEN 'Mar-01-2026' AND 'Mar-26-2026'
  AND datetimeconnect IS NOT NULL
  AND (
    finalcalledpartynumber IN ('5034948311', '5034949034', '5034949732')
    OR originalcalledpartynumber IN ('5034948311', '5034949034', '5034949732')
    OR callingpartynumber IN ('5034948311', '5034949034', '5034949732')
  )
ORDER BY datetimeorigination$q$),
  ('Call count by DN (date range)', $q$WITH directory_number (dn) AS (VALUES ('5034948311'), ('5034949034'))
SELECT dn,
  COALESCE(calls, 0) AS calls,
  COALESCE(total_duration, '00:00:00'::interval) AS total_duration
FROM directory_number
LEFT JOIN (
  SELECT dn, count(*) AS calls, sum(duration) AS total_duration
  FROM (
    SELECT callingpartynumber AS dn, duration FROM cdr
    WHERE datetimeorigination BETWEEN 'Mar-01-2026' AND 'Mar-26-2026'
      AND callingpartynumber IN (SELECT dn FROM directory_number)
      AND duration > '00:00:00'::interval
    UNION ALL
    SELECT finalcalledpartynumber AS dn, duration FROM cdr
    WHERE datetimeorigination BETWEEN 'Mar-01-2026' AND 'Mar-26-2026'
      AND finalcalledpartynumber IN (SELECT dn FROM directory_number)
      AND duration > '00:00:00'::interval
  ) AS detail
  GROUP BY dn
) AS activity USING (dn)
ORDER BY dn$q$),
  ('Calls by hour (last 24h)', $q$SELECT date_trunc('hour', datetimeorigination) AS hour, count(*)
FROM cdr_basic
WHERE datetimeorigination > now() - interval '24 hours'
GROUP BY hour
ORDER BY hour$q$),
  ('Failed calls today', $q$SELECT
  datetimeorigination, callingpartynumber, finalcalledpartynumber,
  duration, origdevicename, destdevicename, origcause, destcause
FROM cdr_augmented
WHERE destcause != 'Normal call clearing'
  AND datetimeorigination > now() - interval '24 hours'
ORDER BY datetimeorigination DESC$q$),
  ('Who disconnected?', $q$SELECT
  datetimeorigination, callingpartynumber, finalcalledpartynumber,
  duration, origdevicename, destdevicename,
  origcallterminationonbehalfof_text, destcallterminationonbehalfof_text,
  origcause, destcause
FROM cdr_augmented
WHERE callingpartynumber = '5034944251'
  AND datetimeorigination BETWEEN 'Mar-01-2026' AND 'Mar-26-2026'
ORDER BY datetimeorigination$q$),
  ('Uncompleted calls (last 10d)', $q$SELECT
  date_trunc('hour', datetimeorigination) AS interval,
  count(*),
  repeat('■', (count(*)::float / 10)::int) AS bar
FROM cdr_augmented
WHERE datetimeorigination > current_date - 10
  AND duration = '00:00:00'
  AND origdevicename NOT LIKE 'RightFax-Prod-%'
GROUP BY date_trunc('hour', datetimeorigination)
ORDER BY interval$q$),
  ('Device call stats (CMR)', $q$SELECT *
FROM cmr_augmented
WHERE 'SEP00D6FE056ADB' IN (localdevicename, remotedevicename)
  AND datetimestamp > current_date - 10
ORDER BY datetimestamp DESC$q$),
  ('Top callers today', $q$SELECT COALESCE(NULLIF(callingpartynumber, ''), 'Unknown') AS callingpartynumber, count(*) AS calls
FROM cdr_basic
WHERE datetimeorigination > now() - interval '24 hours'
GROUP BY callingpartynumber
ORDER BY calls DESC
LIMIT 20$q$)
) AS defaults(name, query)
WHERE NOT EXISTS (SELECT 1 FROM saved_queries);
