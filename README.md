# cisco-cdr-processor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Build & Publish](https://github.com/sieteunoseis/cisco-cdr-processor/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/sieteunoseis/cisco-cdr-processor/actions)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fsieteunoseis%2Fcisco--cdr--processor-blue)](https://github.com/sieteunoseis/cisco-cdr-processor/pkgs/container/cisco-cdr-processor)

A Dockerized Node.js application that collects, parses, enriches, and stores Cisco Unified Communications Manager (CUCM) Call Detail Records (CDR) and Call Management Records (CMR). Compatible with CUCM 12.x through 15.x.

> Pairs with [cisco-cdr-ui](https://github.com/sieteunoseis/cisco-cdr-ui), an optional web dashboard for searching and analyzing the data this app collects.

## What It Does

1. Watches a host-mounted volume for CUCM CDR/CMR files pushed via SFTP
2. Parses CDR (133 columns) and CMR (48 columns) CSV files — supports CUCM 12.x through 15.x
3. Enriches data via cisco-axl (device names, users, device pools, locations) — optional, skipped if not configured
4. Stores records in PostgreSQL using a schema compatible with the existing C# callmanagercdrcollector app
5. Creates `cdr_basic`, `cdr_augmented`, and `cmr_augmented` views for existing team SQL queries
6. Exposes an MCP server (streamable HTTP) for AI agent access (Claude Code, cisco-uc-engineer skill)
7. Exposes a REST API for dashboards and integrations
8. Auto-detects fresh vs. existing database and runs idempotent migrations on every startup
9. Daily retention purge (configurable, default 90 days)
10. Optional Twilio Lookup spam/carrier check (Nomorobo, IceHook Scout, or both) with server-side result caching
11. Shared, DB-backed label rules for classifying calls (regex over calling/called number or device name)
12. DN Map — walks a label's number range against CUCM's AXL `numplan`/`device` tables to show configured vs. unconfigured DNs, assigned devices, and recent call volume
13. Starred calls and per-call diagnostic snapshots (RISPort, phone logs, CDP, config) for incident follow-up

## Architecture

```
CUCM ──SFTP (port 22)──> Host OS ──> /var/cdr-incoming/
                                            │ (volume mount)
                              ┌─────────────┘
                              ▼
                    ┌─────────────────────┐
                    │   CDR Processor     │
                    │   (container)       │
                    │                     │
                    │  File Watcher       │──cisco-axl──> CUCM
                    │  CSV Parser         │
                    │  AXL Enrichment     │
                    │  Postgres Writer    │
                    │  MCP Server (HTTP)  │◄── Claude Code / AI agents
                    │  REST API           │◄── Grafana / dashboards
                    └────────┬────────────┘
                             │
                    ┌────────┴────────────┐
                    │     PostgreSQL      │
                    │    (container)      │
                    └─────────────────────┘
```

## Quick Start

### Option 1: Bundled Postgres (lab/dev, fresh install)

```bash
# Create the incoming directory on the host
mkdir -p /var/cdr-incoming

# Copy and edit the environment file
cp .env.example .env

# Start both containers
docker compose up -d
```

### Option 2: External Postgres (bring your own database)

```bash
mkdir -p /var/cdr-incoming
cp .env.example .env
# Edit .env and set DATABASE_URL to your existing Postgres instance

docker compose -f docker-compose.external-db.yml up -d
```

### Verify it's running

```bash
docker compose logs -f cdr-processor
curl http://localhost:3000/health
```

## Configuration

| Variable             | Default                                                   | Description                            |
| -------------------- | --------------------------------------------------------- | -------------------------------------- |
| `DATABASE_URL`       | `postgresql://cdr:cdr_password@postgres:5432/callmanager` | Postgres connection string             |
| `AXL_HOST_1`         | (none)                                                    | CUCM publisher hostname for cluster 1  |
| `AXL_USERNAME_1`     | (none)                                                    | AXL API username for cluster 1         |
| `AXL_PASSWORD_1`     | (none)                                                    | AXL API password for cluster 1         |
| `AXL_VERSION_1`      | `15.0`                                                    | CUCM AXL schema version for cluster 1  |
| `AXL_CLUSTER_ID_1`   | (none)                                                    | CUCM Enterprise Parameter "Cluster ID" |
| `AXL_CACHE_TTL`      | `86400`                                                   | Enrichment cache TTL in seconds (24h)  |
| `CDR_INCOMING_DIR`   | `/data/incoming`                                          | Directory to watch for CDR/CMR files   |
| `CDR_RETENTION_DAYS` | `90`                                                      | Days to retain CDR/CMR data            |
| `MCP_PORT`           | `3000`                                                    | Port for MCP + REST API server         |
| `LOG_LEVEL`          | `info`                                                    | Log level (`info`, `debug`)            |
| `CORS_ORIGIN`        | `*`                                                       | Allowed origin for the REST API (set to your dashboard's URL) |
| `POSTGRES_PASSWORD`  | `cdr_password`                                            | Postgres password (compose only)       |
| `POSTGRES_PORT`      | `5432`                                                    | Postgres exposed port (compose only)   |
| `TWILIO_ACCOUNT_SID` | (none)                                                    | Twilio Account SID — enables spam/carrier check |
| `TWILIO_API_KEY_SID` | (none)                                                    | Twilio API Key SID                     |
| `TWILIO_API_KEY_SECRET` | (none)                                                 | Twilio API Key Secret                  |
| `TWILIO_SPAM_PROVIDER` | `nomorobo_spamscore`                                    | Comma-separated Lookup v1 add-ons to query (`nomorobo`, `scout`, or both) |

### Spam / Carrier Check (Twilio)

Optional. If `TWILIO_ACCOUNT_SID` and API key credentials are set, `POST /api/v1/spam/check` looks up a number via Twilio Lookup v1 add-ons and caches the result (`GET /api/v1/spam/checked`) so repeat checks don't re-spend add-on credits. `TWILIO_SPAM_PROVIDER` accepts a comma-separated list — e.g. `icehook_scout,nomorobo` — and a number is flagged spam if *any* configured provider flags it. IceHook Scout additionally returns carrier, line type, porting, and geo/LATA/OCN data, which is surfaced in full alongside the spam verdict.

### Multi-Cluster AXL Enrichment

Up to 5 CUCM clusters are supported using numbered environment variables (`_1` through `_5`). Each cluster is matched to CDR records by the `globalcallid_clusterid` field, which corresponds to the CUCM Enterprise Parameter "Cluster ID" (System > Enterprise Parameters in CUCM admin).

```bash
# Cluster 1
AXL_HOST_1=cucm-pub1.example.com
AXL_USERNAME_1=axl-user
AXL_PASSWORD_1=axl-password
AXL_VERSION_1=15.0
AXL_CLUSTER_ID_1=cucmProdCluster

# Cluster 2
AXL_HOST_2=cucm-pub2.example.com
AXL_USERNAME_2=axl-user
AXL_PASSWORD_2=axl-password
AXL_VERSION_2=14.0
AXL_CLUSTER_ID_2=cucmTestCluster
```

Enrichment is optional. If no `AXL_HOST_*` variables are set, the processor skips enrichment and stores raw CDR/CMR data. Enrichment results are cached in PostgreSQL (default 24 hours) to minimize AXL queries.

Enriched fields: device description, device pool, location, owner user ID.

## CUCM Billing Server Setup

Configure in Cisco Unified Serviceability > Tools > CDR Management. Add a billing server with these values:

| Field                | Value                                       |
| -------------------- | ------------------------------------------- |
| Host Name/IP Address | Your billing server hostname or IP          |
| User Name            | SFTP username on the host                   |
| Password             | SFTP password                               |
| Protocol             | SFTP                                        |
| Directory Path       | `/var/cdr-incoming` (or wherever you mount) |

Note: CUCM hardcodes port 22 for SFTP — there is no port field in the UI.

## REST API

Base URL: `http://localhost:3000`

### CDR

| Endpoint                                              | Description                                              |
| ------------------------------------------------------ | --------------------------------------------------------|
| `GET /api/v1/cdr/search?caller=5033466520&last=24h`   | Search CDR by caller, callee, device, cause, time range   |
| `GET /api/v1/cdr/trace/:callId`                       | Full call trace with CDR + CMR records                    |
| `GET /api/v1/cdr/quality?mos_below=3.5&last=7d`       | Find poor-quality calls by MOS threshold                  |
| `GET /api/v1/cdr/related/:callId`                     | Other calls sharing the same parties/devices                |
| `GET /api/v1/cdr/stats/:type`                         | Aggregate stats — `volume`, `top_callers`, `top_called`, `by_cause`, `by_device`, `by_location` |
| `POST /api/v1/cdr/sql`                                | Read-only ad-hoc SQL query execution                        |
| `GET /api/v1/cdr/sql/schema`                          | Table/column reference for the SQL editor                    |
| `POST /api/v1/cdr/logs/collect`                       | Collect SDL/SDI traces via DIME for a call                    |
| `POST /api/v1/cdr/logs/sip-ladder`                    | Kick off SIP ladder trace collection (async job)                |
| `GET /api/v1/cdr/logs/sip-ladder/status/:jobId`       | Poll a SIP ladder collection job                                  |

### Labels

| Endpoint                     | Description                                             |
| ------------------------------ | -------------------------------------------------------- |
| `GET /api/v1/labels`          | List shared label rules                                   |
| `POST /api/v1/labels`         | Create a label rule                                        |
| `POST /api/v1/labels/bulk`    | Import multiple label rules at once                          |
| `PUT /api/v1/labels/:id`      | Update a label rule                                            |
| `DELETE /api/v1/labels/:id`   | Delete a label rule                                              |
| `POST /api/v1/labels/reset`   | Reset to the built-in default rules                                |

### DN Map (numplan)

| Endpoint                                          | Description                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------|
| `GET /api/v1/numplan/seats?pattern=...&page=1`      | Resolve a label pattern to a fixed-width number range and page through configured/unconfigured DNs |
| `GET /api/v1/numplan/devices?number=...`            | Devices assigned to a DN, each with a CUCM admin `phoneEdit.do` link |
| `GET /api/v1/numplan/call-counts?numbers=a,b,c`     | 24h/7d/30d call volume per DN (calling or called)                     |

### Spam / Carrier Check

| Endpoint                                  | Description                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/spam/checked?numbers=a,b,c`   | Batch cache lookup for previously-checked numbers           |
| `POST /api/v1/spam/check`                  | Query configured Twilio Lookup add-ons for a number and cache the result |

### Devices

| Endpoint                                    | Description                                             |
| ----------------------------------------------- | -------------------------------------------------------- |
| `POST /api/v1/device/batch`                    | Batch RISPort device status lookup                         |
| `GET /api/v1/device/:deviceName`               | Device status/network/config detail                           |
| `GET /api/v1/device/:deviceName/logs`          | Available syslog files for a device                              |
| `GET /api/v1/device/:deviceName/web/:page`     | Scraped phone web page (network, config, status, syslog)          |

### Starred Calls & Snapshots

| Endpoint                                            | Description                                             |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/starred`                                   | List starred calls                                         |
| `POST /api/v1/starred/check`                            | Batch-check which of a list of calls are starred              |
| `GET /api/v1/starred/:callId/:callManagerId`            | Check if a specific call is starred                              |
| `POST /api/v1/starred/:callId/:callManagerId`           | Star a call                                                        |
| `DELETE /api/v1/starred/:callId/:callManagerId`         | Unstar a call                                                        |
| `GET /api/v1/snapshots/:callId/:cmId`                   | List snapshots for a call                                              |
| `POST /api/v1/snapshots/:callId/:cmId`                  | Take a diagnostic snapshot (RISPort, phone logs, CDP, config)             |
| `GET /api/v1/snapshots/:callId/:cmId/:type`             | Retrieve one snapshot's stored data                                        |

### Health

| Endpoint       | Description                                              |
| -------------- | ---------------------------------------------------------|
| `GET /health`  | Health check — database stats, file processing activity  |

## MCP Server (AI Agent Access)

The application exposes a [Model Context Protocol](https://modelcontextprotocol.io) server at `http://localhost:3000/mcp` (streamable HTTP transport).

### Available MCP Tools

| Tool          | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `cdr_search`  | Search CDR by caller, callee, device, cause, time range      |
| `cdr_trace`   | Full call trace with CDR + CMR + cisco-dime SDL command      |
| `cdr_quality` | Find poor-quality calls by MOS, jitter, latency, packet loss |
| `cdr_stats`   | Call volume, top callers/called, by cause/device/location    |
| `cdr_health`  | Database stats, file processing activity, cache status       |
| `numplan_find_available` | Find unconfigured DNs within a labeled number-bank range |

### Claude Code Configuration

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "cisco-cdr": {
      "type": "url",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## SQL Views

Three views are created automatically on startup for use in DBeaver, psql, or Grafana:

| View            | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| `cdr_basic`     | Core call fields with human-readable timestamps                  |
| `cdr_augmented` | CDR with cause code descriptions, codec names, on-behalf-of text |
| `cmr_augmented` | CMR records with local/remote device names joined from CDR       |

## Grafana Dashboard

A sample dashboard is included at [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json) — 16 panels covering call volume, failure rate, top calling/called numbers, MOS/jitter/latency/packet-loss trends, codec distribution, device quality, and the configured alert rules. Every panel is scoped by a **Label** dropdown, so it works with whatever label rules you've defined (see [cisco-cdr-ui's README](https://github.com/sieteunoseis/cisco-cdr-ui#grafana-dashboard) for how labels are created — they're managed there, but every panel here reads them live).

### 1. Create a read-only Postgres role

Grafana only needs `SELECT`. Don't point it at this app's own read/write `DATABASE_URL` role.

```sql
CREATE ROLE grafana_reader LOGIN PASSWORD '<pick a strong password>';
GRANT CONNECT ON DATABASE <your_db_name> TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_reader;
```

The `ALTER DEFAULT PRIVILEGES` line matters here specifically because this app's migrations (`sql/Migration*.sql`) re-run on every boot and can add new tables — without it, a future migration's table would silently be unreadable by Grafana until someone remembers to re-grant.

If your Postgres server authenticates connections via `pg_hba.conf` rules keyed on username (for example, an LDAP catch-all for anything not explicitly listed), `grafana_reader`'s password does nothing unless it also has its own `scram-sha-256` (or equivalent) line **above** that catch-all:

```
host    all             grafana_reader  0.0.0.0/0               scram-sha-256
```

Then reload Postgres to pick it up — no restart needed:

```sql
SELECT pg_reload_conf();
```

### 2. Add the Postgres datasource in Grafana

Connections → Add data source → PostgreSQL. Host/port/database from this app's own `DATABASE_URL`, user `grafana_reader`, the password you set above, and whatever TLS/SSL mode your Postgres server requires (`disable` if it's not configured for TLS). Save & test — it should come back green.

### 3. Import the sample dashboard

Dashboards → New → Import → Upload JSON file → `docs/grafana-dashboard.json`. Grafana will prompt for:

- **PostgreSQL** — pick the datasource you just created
- **CDR UI base URL** (`cdr_ui_url` variable) — the base URL of your `cisco-cdr-ui` deployment, used by the "Search this number in CDR" links on the Top Calling/Top Called panels. Leave the placeholder if you don't have the UI deployed and just want the raw data.

### How the label-aware queries work

Labels aren't stored on individual CDR rows — `label_rules` just holds a pattern per label, matched live. Every panel that's scoped by the **Label** variable uses the same shape:

```sql
AND (
  '__all__' = ANY(string_to_array('${label:csv}', ','))
  OR EXISTS (
    SELECT 1 FROM label_rules lr
    WHERE lr.label = ANY(string_to_array('${label:csv}', ',')) AND lr.enabled
      AND (
        (lr.fields ? 'calling' AND c.callingpartynumber ~* lr.pattern)
        OR (lr.fields ? 'called' AND c.finalcalledpartynumber ~* lr.pattern)
        OR (lr.fields ? 'origDevice' AND c.origdevicename ~* lr.pattern)
        OR (lr.fields ? 'destDevice' AND c.destdevicename ~* lr.pattern)
      )
  )
)
```

`${label:csv}` is Grafana's multi-value variable formatted as a plain comma-separated list — the `'__all__'` sentinel (the variable's "Custom all value") means "no filter" when the dropdown is set to All, and otherwise the query matches any call against any of the selected labels' patterns. This mirrors the same label-to-SQL logic `src/api/routes/alerts.js`'s `loadLabelMatchClause` already uses for `label_volume` alert rules, just inlined for a raw SQL panel. Because it's time-bounded via `$__timeFilter` on every panel and `label_rules` is a small table, the `EXISTS` join stays cheap regardless of how large `cdr` grows.

Any label you create — via the frontend's Settings page, `POST /api/v1/labels`, or a direct `INSERT INTO label_rules` — becomes selectable in the dashboard's Label dropdown immediately, no dashboard changes required.

## Migration from the C# App

The database schema is fully compatible with the existing C# callmanagercdrcollector application. On first startup against an existing database:

1. Detects existing `cdr` and `cmr` tables
2. Adds CUCM 14/15 columns and enrichment columns using `IF NOT EXISTS`
3. Creates performance indexes
4. Creates the three SQL views
5. Existing data is untouched

No manual migration steps are required.

## CUCM Version Compatibility

| CUCM Version | CDR Columns | CMR Columns | Status    |
| ------------ | ----------- | ----------- | --------- |
| 12.x         | 133         | 48          | Supported |
| 14.x         | 133+        | 48+         | Supported |
| 15.x         | 133+        | 48+         | Supported |

## Docker Compose Files

| File                             | Use Case                                       |
| -------------------------------- | ---------------------------------------------- |
| `docker-compose.yml`             | Lab/dev — includes bundled Postgres            |
| `docker-compose.external-db.yml` | Production — processor only, external Postgres |

## Related Projects

[cisco-cdr-ui](https://github.com/sieteunoseis/cisco-cdr-ui) — an optional web dashboard that consumes this app's REST API for searching, call detail, SQL querying, the DN Map, and spam checks. Point its `API_URL` at this app's base URL and enable CORS (`CORS_ORIGIN`) to use it.

## Support

If you find this project useful, consider supporting development:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?style=flat&logo=buy-me-a-coffee)](https://buymeacoffee.com/automatebldrs)

## License

MIT
