# O01 — Observability — PLAN

**Module:** O01 (Operations, Phase 1, start early)
**Author:** O01 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 22 citations behind every choice.

This plan converts O01.md + RESEARCH.md findings into the exact stack,
files, scrape topology, alert rules, dashboard inventory, and hand-off
contracts that the IMPLEMENT phase will deliver. Once approved, the
public interface (metric names, alert names, port allocations) is
FROZEN per SPEC §3.6/§3.11.

---

## 0. TL;DR (10 bullets)

1. **Stack:** Prometheus 3.x + Alertmanager 0.27+ + Grafana 11.x OSS,
   shipped as a `docker-compose.observability.yml` overlay attached to
   the F01 main bridge network; tear-down independent of the dialer
   plane. 30-day local TSDB retention to mirror the FCC drop-rate window.
2. **Eight scrape jobs** in one Prometheus instance: `api:9101` (15 s),
   `dialer:9102` (5 s), `workers:9103` (15 s), `fs-exporter:9104` (15 s),
   `mysqld-exporter:9105` (30 s), `valkey-exporter:9106` (15 s),
   `node-exporter:9107` (15 s), `web:9108` (60 s). Ports follow F01's
   `:910x` allocation block.
3. **Seven alert-rule files** under `prom/rules/`: `dialer.yml`,
   `agents.yml`, `freeswitch.yml`, `mysql.yml`, `redis.yml`,
   `hosts.yml`, `compliance.yml`. The compliance file is bound to
   SPEC §4.1 hard floors and is zero-tolerance on DNC/TCPA/recording
   metrics.
4. **In-house `freeswitch-exporter`** in Go at `dialer/cmd/fs-exporter/`,
   reusing T01's `eslgo` library and supervisor pattern. ~300 LoC; one
   binary per FS host (Phase 4 sharding-ready).
5. **Cardinality discipline** is CI-enforced: a forbidden-label
   denylist (`call_uuid`, `agent_id`, `lead_id`, `phone_number`,
   `request_id`, `session_id`) and a per-metric series ceiling (10 k).
6. **Native histograms by default**; NHCB (custom buckets) for the
   compliance histograms that need a fixed FCC 2 s cutoff. Classic
   histogram dual-emit during the migration window.
7. **8 Grafana dashboards** authored as `.libsonnet` (grafonnet) under
   `grafana/src/`, compiled to JSON checked into `grafana/dashboards/`,
   provisioned via the file provider.
8. **Alertmanager routing tree:** `severity=page` → PagerDuty + Slack
   `#oncall`; `severity=warn` → Slack `#vici2-alerts`; `severity=info`
   → email digest. Inhibition: FreeSWITCH-down inhibits derivatives.
9. **Drop-rate denominator** = 30-day Prometheus rolling rate, mirrored
   to MySQL by E05 worker as the audit-of-record (defense in depth).
10. **Tracing/logs deferred.** OpenTelemetry traces are Phase 2; log
    aggregation (Loki/Alloy) is a separate Phase 2 module. O01 v1 is
    metrics + alerts only.

---

## 1. Stack & topology

### 1.1 Versions (pinned)

| Component | Version | Image | Why |
|---|---|---|---|
| Prometheus | **3.x** (latest 3.x patch) | `prom/prometheus:v3.x.y` | Native histograms stable, RW2, OOO ingestion (RESEARCH §2.1, [1][2][3]) |
| Alertmanager | **0.27+** | `prom/alertmanager:v0.27.x` | Inhibition rules, silence API, PagerDuty/Slack receivers ([10]) |
| Grafana OSS | **11.x** | `grafana/grafana-oss:11.x.y` | grafonnet provisioning, Grafana-managed recording rules available but unused ([12]) |
| node_exporter | **1.8.x** | `prom/node-exporter:v1.8.x` | Stock host metrics |
| mysqld_exporter | **0.16.x** | `prom/mysqld-exporter:v0.16.x` | RESEARCH §4.4 ([17][22]) |
| redis_exporter | **1.62.x** (Valkey-compatible) | `oliver006/redis_exporter:v1.62.x` | RESEARCH §4.5 |
| freeswitch-exporter | **vici2/fs-exporter:dev** | built from `dialer/cmd/fs-exporter` | RESEARCH §4.3 |

Storage: local TSDB; `--storage.tsdb.retention.time=30d` to match the
FCC 30-day rolling drop-rate window (SPEC §4.1, RESEARCH §2.1, [11]).

### 1.2 Network topology (single host, Phase 1)

- **One Prometheus** instance in the obs overlay. No federation, no
  remote-write, no Thanos in Phase 1. Designed with RW2 in mind for
  Phase 4.
- **Pull model** end-to-end. Static target lists; Phase 4 will move to
  `file_sd_configs` against a JSON file the API renders.
- **Docker network bridge** named `vici2_default` (already declared by
  F01) — the obs overlay joins this network as `external: true` so
  services are reachable by their compose service name.

### 1.3 Compose overlay sketch — `docker-compose.observability.yml`

```yaml
name: vici2-observability

x-common-env: &common-env
  TZ: UTC
  LOG_LEVEL: info

services:

  prometheus:
    image: prom/prometheus:v3.x.y
    container_name: vici2_prometheus
    restart: unless-stopped
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=30d
      - --web.enable-lifecycle              # /-/reload
      - --web.enable-remote-write-receiver  # off-by-default; future RW2
      - --enable-feature=native-histograms
    volumes:
      - ./prom/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./prom/rules:/etc/prometheus/rules:ro
      - prometheus_data:/prometheus
    ports: ["9090:9090"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
    depends_on:
      alertmanager: { condition: service_healthy }
    networks: [vici2_default]

  alertmanager:
    image: prom/alertmanager:v0.27.x
    container_name: vici2_alertmanager
    restart: unless-stopped
    command:
      - --config.file=/etc/alertmanager/alertmanager.yml
      - --storage.path=/alertmanager
      - --web.external-url=https://alerts.vici2.local   # placeholder
    volumes:
      - ./alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager_data:/alertmanager
    ports: ["9093:9093"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9093/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks: [vici2_default]

  grafana:
    image: grafana/grafana-oss:11.x.y
    container_name: vici2_grafana
    restart: unless-stopped
    environment:
      <<: *common-env
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_INSTALL_PLUGINS: ""               # pure OSS; no plugin pulls
    volumes:
      - ./grafana/datasources:/etc/grafana/provisioning/datasources:ro
      - ./grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports: ["3001:3000"]                   # 3000 reserved for api by F01
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health | grep -q ok"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
    depends_on:
      prometheus: { condition: service_healthy }
    networks: [vici2_default]

  fs-exporter:
    image: vici2/fs-exporter:dev
    build:
      context: ../dialer
      dockerfile: cmd/fs-exporter/Dockerfile
    container_name: vici2_fs_exporter
    restart: unless-stopped
    environment:
      <<: *common-env
      FS_ESL_HOST: host.docker.internal
      FS_ESL_PORT: 8021
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
      FS_HOST_LABEL: ${FS_HOST_LABEL:-fs01}
      LISTEN_ADDR: ":9104"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports: ["9104:9104"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9104/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks: [vici2_default]

  mysqld-exporter:
    image: prom/mysqld-exporter:v0.16.x
    container_name: vici2_mysqld_exporter
    restart: unless-stopped
    command:
      - --collect.global_status
      - --collect.global_variables
      - --collect.info_schema.innodb_metrics
      - --collect.info_schema.innodb_cmp
      - --collect.info_schema.innodb_cmpmem
      - --collect.perf_schema.eventsstatementssum
      - --collect.engine_innodb_status
      - --no-collect.info_schema.processlist
      - --no-collect.perf_schema.eventswaits
      - --web.listen-address=:9105
    environment:
      DATA_SOURCE_NAME: "${VICI2_DB_USER}:${VICI2_DB_PASSWORD}@(mysql:3306)/"
    ports: ["9105:9105"]
    networks: [vici2_default]

  valkey-exporter:
    image: oliver006/redis_exporter:v1.62.x
    container_name: vici2_valkey_exporter
    restart: unless-stopped
    command:
      - --redis.addr=redis://redis:6379
      - --web.listen-address=:9106
      - --check-keys=t:*:agent:*:state,t:*:hopper:*
    ports: ["9106:9106"]
    networks: [vici2_default]

  node-exporter:
    image: prom/node-exporter:v1.8.x
    container_name: vici2_node_exporter
    restart: unless-stopped
    pid: host
    command:
      - --path.rootfs=/host
      - --no-collector.wifi
      - --no-collector.ipvs
      - --no-collector.textfile
      - --web.listen-address=:9107
    volumes:
      - /:/host:ro,rslave
    ports: ["9107:9107"]
    networks: [vici2_default]

volumes:
  prometheus_data:
  alertmanager_data:
  grafana_data:

networks:
  vici2_default:
    external: true
```

`web` exports `/api/metrics` on its own service port (`:9108` in
addition to F01's `:4000` UI port) only when `WEB_METRICS_ENABLED=1`;
Prometheus scrapes via the Next.js custom endpoint at 60 s.

---

## 2. `prom/prometheus.yml` (full content)

Eight scrape jobs, scrape interval per service, Alertmanager target on
:9093, rule files glob.

```yaml
global:
  scrape_interval:     15s
  scrape_timeout:      10s
  evaluation_interval: 15s
  external_labels:
    cluster: vici2-phase1
    env: dev
    tenant_id: "1"

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
      timeout: 10s
      api_version: v2

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:

  # --- vici2 services ---

  - job_name: vici2-api
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout:  7s
    static_configs:
      - targets: ["api:9101"]
        labels: { service: api, layer: app }

  - job_name: vici2-dialer            # 5s — drop-rate accounting
    metrics_path: /metrics
    scrape_interval: 5s
    scrape_timeout:  4s
    static_configs:
      - targets: ["dialer:9102"]
        labels: { service: dialer, layer: app }

  - job_name: vici2-workers
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout:  7s
    static_configs:
      - targets: ["workers:9103"]
        labels: { service: workers, layer: app }

  - job_name: vici2-fs-exporter
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout:  7s
    static_configs:
      - targets: ["fs-exporter:9104"]
        labels: { service: freeswitch, layer: telephony, fs_host: fs01 }

  - job_name: vici2-mysqld-exporter
    metrics_path: /metrics
    scrape_interval: 30s
    scrape_timeout:  10s
    static_configs:
      - targets: ["mysqld-exporter:9105"]
        labels: { service: mysql, layer: data }

  - job_name: vici2-valkey-exporter
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout:  7s
    static_configs:
      - targets: ["valkey-exporter:9106"]
        labels: { service: redis, layer: data }

  - job_name: vici2-node-exporter
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout:  7s
    static_configs:
      - targets: ["node-exporter:9107"]
        labels: { service: host, layer: infra, host_role: app }

  - job_name: vici2-web
    metrics_path: /api/metrics
    scrape_interval: 60s
    scrape_timeout:  20s
    static_configs:
      - targets: ["web:9108"]
        labels: { service: web, layer: app }
```

Recording rules (filed in `prom/rules/recording/*.yml`, separate from
alerts; RESEARCH §2.3) are scaffolded but their bodies are out of scope
for this PLAN — they appear in IMPLEMENT once the metrics they aggregate
exist.

---

## 3. Alert rule files

Seven files under `prom/rules/` (one per concern). All alerts carry at
least `severity` (`page|warn|info`) and `team` labels; the routing tree
in §6 dispatches by `severity`.

### 3.1 `prom/rules/compliance.yml` — TIED TO SPEC §4.1 HARD FLOORS

| Alert | Expr | For | Severity | Why |
|---|---|---|---|---|
| `Vici2DropRateApproachingFCC` | `vici2_dialer_drop_ratio > 0.025` | 5 m | **warn** | FCC 3% ceiling [11]; alert at 2.5% gives runway; team=oncall |
| `Vici2DropRateImminentBreach` | `vici2_dialer_drop_ratio > 0.029` | 1 m | **page** | 0.1% headroom before regulatory breach |
| `Vici2DNCBypass`              | `increase(vici2_compliance_dnc_bypass_total[5m]) > 0` | 0 m | **page** | Zero-tolerance; statutory damages $500–1500/call |
| `Vici2TCPAOutsideWindow`      | `increase(vici2_compliance_tcpa_outside_window_total[5m]) > 0` | 0 m | **page** | Zero-tolerance; SPEC §4.1 8 am–9 pm gate |
| `Vici2RecordingConsentMissing`| `increase(vici2_compliance_recording_consent_missing_total[5m]) > 0` | 0 m | **page** | Zero-tolerance; 2-party-consent jurisdictions |
| `Vici2FreeSwitchDown`         | `vici2_freeswitch_up == 0` | 30 s | **page** | All call-flow downstream depends on FS; inhibits derivatives |

All page-severity rules in this file include:
```yaml
labels:
  severity: page
  team: oncall
  compliance: "true"
annotations:
  summary: "<one-line>"
  runbook: "https://repo/spec/runbooks/oncall.md#<alertname>"
  dashboard: "https://grafana.vici2.local/d/compliance"
```

### 3.2 `prom/rules/dialer.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2HopperStarved`        | `vici2_dialer_hopper_depth < (vici2_agent_state_count{state="ready"} * 1.5)` | 2 m | warn |
| `Vici2HopperFloor`          | `vici2_dialer_hopper_depth == 0 and vici2_agent_state_count{state="ready"} > 0` | 1 m | page |
| `Vici2DialerOriginateLatencyHigh` | `histogram_quantile(0.99, sum by (le) (rate(vici2_dialer_originate_latency_seconds_bucket[5m]))) > 1.0` | 5 m | warn |
| `Vici2DialerErrorRateHigh`  | `sum(rate(vici2_dialer_errors_total[5m])) > 1` | 5 m | warn |
| `Vici2DialerPacingDrift`    | `histogram_quantile(0.95, sum by (le) (rate(vici2_dialer_pacing_drift_seconds_bucket[5m]))) > 0.5` | 10 m | warn |

### 3.3 `prom/rules/agents.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2AgentStateAnomaly`     | `sum(vici2_agent_state_count) by (state) == 0 unless on() vector(0)` | — | info |
| `Vici2AgentNoneReady`        | `sum(vici2_agent_state_count{state="ready"}) == 0 and sum(vici2_agent_state_count{state="loggedin"}) > 0` | 5 m | warn |
| `Vici2AgentAHTOutlier`       | `histogram_quantile(0.95, sum by (le) (rate(vici2_agent_state_duration_seconds_bucket{state="incall"}[15m]))) > 1800` | 10 m | info |

### 3.4 `prom/rules/freeswitch.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2ESLDisconnect`        | `increase(vici2_esl_reconnects_total[5m]) > 3` | 5 m | warn |
| `Vici2ESLEventLatencyHigh`  | `histogram_quantile(0.99, sum by (le) (rate(vici2_freeswitch_esl_event_latency_seconds_bucket[5m]))) > 0.5` | 5 m | warn |
| `Vici2FSConferenceLeak`     | `vici2_freeswitch_conferences_active > (sum(vici2_agent_state_count{state="loggedin"}) * 1.2)` | 10 m | warn |
| `Vici2ESLConnectionDown`    | `vici2_esl_connection_status == 0` | 1 m | page |

### 3.5 `prom/rules/mysql.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2MySQLDown`             | `mysql_up == 0` | 1 m | page |
| `Vici2MySQLReplicationLag`   | `mysql_slave_lag_seconds > 30` | 5 m | warn |
| `Vici2MySQLConnUsageHigh`    | `mysql_global_status_threads_connected / mysql_global_variables_max_connections > 0.85` | 5 m | warn |
| `Vici2MySQLBufferPoolLow`    | `rate(mysql_global_status_innodb_buffer_pool_reads[5m]) / rate(mysql_global_status_innodb_buffer_pool_read_requests[5m]) > 0.05` | 10 m | warn |

### 3.6 `prom/rules/redis.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2RedisDown`             | `redis_up == 0` | 30 s | page |
| `Vici2RedisMemoryHigh`       | `redis_memory_used_bytes / redis_memory_max_bytes > 0.90` | 5 m | warn |
| `Vici2RedisEvictions`        | `increase(redis_evicted_keys_total[5m]) > 0` | 5 m | warn |
| `Vici2RedisReplicationLag`   | `redis_master_repl_offset - redis_slave_repl_offset > 1000000` | 5 m | warn |

### 3.7 `prom/rules/hosts.yml`

| Alert | Expr | For | Severity |
|---|---|---|---|
| `Vici2HostCPUSaturated`      | `1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) > 0.85` | 10 m | warn |
| `Vici2HostMemPressure`       | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10` | 10 m | warn |
| `Vici2HostDiskFillingFast`   | `predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 24*3600) < 0` | 30 m | warn |
| `Vici2HostDiskCritical`      | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.05` | 5 m | page |
| `Vici2HostDown`              | `up{job="vici2-node-exporter"} == 0` | 2 m | page |

---

## 4. `freeswitch-exporter` — in-house Go binary

### 4.1 Location & layout

```
dialer/
├── cmd/
│   ├── dialer/
│   │   └── main.go              # F01 stub
│   └── fs-exporter/             # NEW — O01
│       ├── main.go              # entry point
│       ├── Dockerfile           # multi-stage; ~25 MB final image
│       └── README.md
├── internal/
│   └── fsexporter/              # NEW
│       ├── collector.go         # prometheus.Collector impl
│       ├── poller.go            # 60s full snapshot
│       ├── eventstream.go       # delta stream consumer
│       ├── parsers.go           # `show calls` etc. text parsers
│       └── reconcile.go         # snapshot ⊕ delta merge
```

### 4.2 Library reuse

- **`eslgo`** — same library T01 chose for the dialer's ESL client.
  Reused via `dialer/internal/esl` package re-export. One bug class to
  maintain.
- **`prometheus/client_golang`** — same as the dialer.
- **Supervisor pattern** — copies T01's reconnect-with-backoff
  supervisor (`internal/esl/supervisor.go`); the exporter opens its
  OWN ESL connection on the same FS instance, separate from the
  dialer's. Two ESL sessions per FS host is well within FS limits and
  prevents the exporter from interfering with dialer event handling.

### 4.3 Reconcile semantics (open-question resolution)

**Hybrid: full snapshot every 60 s + delta event stream.** On reconnect:
hold last-known gauge values, mark `vici2_freeswitch_up=0` and
`vici2_esl_connection_status=0` until the first successful poll, then
swap atomically. Counters never decrement; gauges flip only on confirmed
poll. Dashboards see a brief "stale" indicator (we expose
`vici2_freeswitch_last_poll_seconds`) rather than a flicker to zero.

### 4.4 Polling commands

| ESL `api` command | Period | Metric(s) populated |
|---|---|---|
| `show calls count`        | 5 s  | `vici2_freeswitch_calls_active` |
| `show channels count`     | 5 s  | `vici2_freeswitch_channels_active` |
| `show registrations`      | 30 s | `vici2_freeswitch_registrations_total` (gauge by profile) |
| `conference list`         | 10 s | `vici2_freeswitch_conferences_active`, `vici2_freeswitch_conference_participants{kind}` |
| `status`                  | 60 s | `vici2_freeswitch_uptime_seconds`, `vici2_freeswitch_up` |
| `sofia status`            | 30 s | `vici2_freeswitch_sip_dialogs`, `vici2_freeswitch_sofia_profile_status{profile}` |

### 4.5 Event subscriptions (delta stream)

`CHANNEL_CREATE | CHANNEL_DESTROY | CHANNEL_ANSWER | CONFERENCE_CREATE
| CONFERENCE_DESTROY | CUSTOM mod_callcenter::*` — feeds counters and
the latency histogram (now − Event-Date-Timestamp).

### 4.6 Exposed metrics

All carry `fs_host` label (always present, even Phase 1 single-FS):

- `vici2_freeswitch_up{fs_host}` — gauge 0/1
- `vici2_freeswitch_uptime_seconds{fs_host}` — gauge
- `vici2_freeswitch_calls_active{fs_host}` — gauge
- `vici2_freeswitch_channels_active{fs_host}` — gauge
- `vici2_freeswitch_conferences_active{fs_host}` — gauge
- `vici2_freeswitch_conference_participants{fs_host, kind="agent|customer"}` — gauge
- `vici2_freeswitch_registrations_total{fs_host, profile}` — gauge
- `vici2_freeswitch_sip_dialogs{fs_host, profile}` — gauge
- `vici2_freeswitch_sofia_profile_status{fs_host, profile, state}` — gauge
- `vici2_freeswitch_last_poll_seconds{fs_host}` — gauge (staleness)
- `vici2_freeswitch_esl_event_latency_seconds{fs_host, event_type}` — histogram (NHCB)
- `vici2_esl_events_total{fs_host, type}` — counter
- `vici2_esl_originate_latency_seconds{fs_host}` — histogram (native)
- `vici2_esl_reconnects_total{fs_host}` — counter
- `vici2_esl_connection_status{fs_host}` — gauge 0/1
- `vici2_freeswitch_exporter_recovered_total{fs_host}` — counter (per SPEC §4.7)

`event_type` and `profile` are bounded enums, allowed.

---

## 5. Cardinality discipline

### 5.1 Forbidden labels (CI-blocking)

The following label names are **rejected at PR time** by a CI grep
across all `*.go`, `*.ts` files for prom-client / client_golang
registrations:

`call_uuid`, `b_leg_uuid`, `session_uuid`, `session_id`,
`agent_id`, `user_id`, `lead_id`, `phone_number`, `caller_id`, `dnis`,
`request_id`, `trace_id`, `email`, `ip_address`.

### 5.2 Allowed labels (audited list)

`tenant_id` (single value Phase 1), `campaign_id` (~tens, bounded),
`carrier`, `state`, `disposition`, `pause_code`, `outcome`, `reason`,
`route`, `method`, `status`, `code`, `kind`, `fs_host`, `profile`,
`event_type`, `mode`, `result`.

Adding any other label requires an RFC + cardinality budget.

### 5.3 CI enforcement steps (added to F01's `make lint` target)

1. **`promtool check rules prom/rules/*.yml`** — syntax + structural.
2. **`promtool check config prom/prometheus.yml`** — config validation.
3. **`scripts/cardinality-lint.sh`** — `grep -RE` over Go/TS sources for
   `prometheus.NewCounterVec|NewGaugeVec|NewHistogramVec|
   new (?:Counter|Gauge|Histogram)\(`. Parses label list; fails if any
   label is in the forbidden set or not in the allowed list.
4. **`scripts/cardinality-estimate.sh`** — runs an in-CI scrape against
   stub services; queries
   `count(count by (__name__)({__name__=~"vici2_.+"}))` and fails if
   any single metric exceeds 10 k series. Catches regressions before
   prod.

### 5.4 Phase 1 budget

Estimated active series at Phase 1 (1 tenant, 10 campaigns, 100 agents,
6 services × ~30 metrics): **< 50 k**, well inside Prometheus single-host
comfort zone (hard guideline: < 10 M [14]). Re-evaluate at Phase 4.

---

## 6. Metric naming convention (concrete examples)

All metrics are `vici2_<subsystem>_<unit>` per SPEC §3.6. Examples below
are the FROZEN baseline set; downstream modules add their own under the
same convention and list them in their PLAN.

### 6.1 `vici2_api_*`

- `vici2_api_request_duration_seconds` — histogram (native)
- `vici2_api_requests_total{route, method, status}` — counter
- `vici2_api_response_size_bytes` — histogram (native)
- `vici2_api_active_websockets` — gauge
- `vici2_api_uptime_seconds` — gauge
- `vici2_api_build_info{version, commit}` — info gauge
- `vici2_api_errors_total{code}` — counter (codes from SPEC §3.5 catalog)

### 6.2 `vici2_dialer_*`

- `vici2_dialer_originates_total{campaign_id, carrier, outcome}` — counter
- `vici2_dialer_bridged_total{campaign_id}` — counter
- `vici2_dialer_drop_ratio` — gauge (recording-rule output, per campaign)
- `vici2_dialer_drop_window_total{campaign_id, reason}` — counter (numerator)
- `vici2_dialer_hopper_depth{campaign_id}` — gauge
- `vici2_dialer_pacing_ratio{campaign_id}` — gauge
- `vici2_dialer_pacing_dial_level{campaign_id}` — gauge
- `vici2_dialer_pacing_drift_seconds` — histogram (NHCB)
- `vici2_dialer_originate_latency_seconds{campaign_id}` — histogram (native)
- `vici2_dialer_errors_total{code}` — counter
- `vici2_dialer_recovered_total` — counter (per SPEC §4.7)

### 6.3 `vici2_agent_*`

- `vici2_agent_state_count{state="ready|paused|incall|wrapup|loggedin|loggedout"}` — gauge (≤ 6 series)
- `vici2_agent_state_duration_seconds{state}` — histogram (native)
- `vici2_agent_calls_handled_total{disposition}` — counter
- `vici2_agent_state_transitions_total{from, to}` — counter (≤ state² series)
- `vici2_agent_pause_code_count{pause_code}` — gauge

### 6.4 `vici2_freeswitch_*` and `vici2_esl_*`

See §4.6 above.

### 6.5 `vici2_compliance_*`

- `vici2_compliance_tcpa_outside_window_total{campaign_id, reason}` — counter
- `vici2_compliance_dnc_bypass_total{list_type}` — counter
- `vici2_compliance_dnc_scrub_total{result="pass|fail"}` — counter
- `vici2_compliance_recording_consent_missing_total{state}` — counter
- `vici2_compliance_timezone_gate_blocked_total{reason}` — counter
- `vici2_compliance_audit_log_writes_total{outcome}` — counter

### 6.6 `vici2_workers_*`

- `vici2_workers_jobs_total{job, outcome}` — counter
- `vici2_workers_job_duration_seconds{job}` — histogram (native)
- `vici2_workers_queue_depth{job}` — gauge

### 6.7 Base (every service, per SPEC §3.6)

- `vici2_<svc>_uptime_seconds`
- `vici2_<svc>_build_info{version, commit}`
- `vici2_<svc>_errors_total{code}`
- Plus runtime defaults (`process_*`, `go_gc_*`, `nodejs_eventloop_lag_seconds`).

---

## 7. Histogram strategy

- **Native histograms by default** for every new histogram. Configured
  via `prometheus/client_golang` `NativeHistogramBucketFactor=1.1`
  (~10% relative resolution).
- **NHCB (Native Histograms with Custom Buckets)** for compliance
  histograms that need a fixed cutoff:
  - `vici2_dialer_drop_window_total` related histograms — buckets
    `[0, 1.0, 1.5, 2.0, 2.5]` (FCC 2 s abandonment definition [11]).
  - `vici2_freeswitch_esl_event_latency_seconds` — buckets
    `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]` for latency SLO.
- **Classic histograms dual-emitted** during the migration window via
  `always_scrape_classic_histograms: true` so existing dashboards keep
  rendering. Classic emission is REMOVED in a follow-up PR once we
  verify NHCB dashboards work end-to-end.
- **Open-question resolution** (RESEARCH §10.3): NHCB confirmed for
  compliance metrics. Classic dual-emit retained for one release cycle.

---

## 8. Grafana dashboards (8 total)

### 8.1 Authoring & provisioning

- **Source of truth:** `.libsonnet` files under `grafana/src/`,
  authored against the upstream `grafana/grafonnet` library.
- **Toolchain:** `go-jsonnet` (NOT C jsonnet) + `jsonnet-bundler` (`jb`).
- **Build:** `make grafana-build` runs
  `jsonnet -J vendor/ -m grafana/dashboards/ grafana/src/*.jsonnet`.
  Output JSON files committed to `grafana/dashboards/`.
- **Provisioning:** `grafana/datasources/prometheus.yml` declares
  Prometheus as default DS; `grafana/provisioning/dashboards/file.yml`
  points the file provider at `grafana/dashboards/`.
- **Shared lib:** `grafana/src/lib/{panels,layouts,prefixes}.libsonnet`
  with reusable panel constructors so all 8 dashboards share styling.

### 8.2 Dashboard inventory (≤ 20 panels each)

| # | UID / file | Audience | Key panels |
|---|---|---|---|
| 1 | `exec` / `exec.json` | execs, supervisors | global drop% gauge with FCC 3% line, calls/sec, agents ready/total, top-5 campaigns, 24 h alert summary, SLO burn-rate |
| 2 | `dialer` / `dialer.json` | dialer engineers | originates/sec, bridged/sec, drop% by campaign, pacing dial level, pacing-drift histogram heatmap, hopper depth, originate latency p50/p95/p99, errors-by-code |
| 3 | `agents` / `agents.json` | supervisors | state breakdown stacked area, pause codes pie, AHT histogram, login/logout transitions, productivity (calls/agent/hr) |
| 4 | `freeswitch` / `freeswitch.json` | SRE | calls active, conferences active, conference participants by kind, RTP loss%, SIP dialogs, FS uptime, ESL connection state per `fs_host`, ESL event latency p99 |
| 5 | `mysql` / `mysql.json` | DBA / SRE | QPS, slow queries, InnoDB buffer-pool hit ratio, replication lag, connections in use, transactions/sec, top tables |
| 6 | `redis` / `redis.json` | SRE | ops/sec, memory used vs max, keyspace hits/misses, evicted keys, replication lag, key counts (hopper, agent state) |
| 7 | `hosts` / `hosts.json` | SRE | per-host CPU%, mem%, disk%, network I/O, load avg, file descriptors |
| 8 | `compliance` / `compliance.json` | compliance officer | DNC scrub pass/fail, TZ-gate blocks, recording-consent prompts, drop% per campaign with FCC 3% line, audit-log write rate, all PAGE alerts in last 30 d |

Hard-limit ≤ 20 panels per dashboard; exec stays under 12. Recording
rules absorb expensive PromQL so panels render pre-computed series
(RESEARCH §3.3).

---

## 9. Alertmanager config (`alertmanager/alertmanager.yml`)

### 9.1 Routing tree

```yaml
global:
  resolve_timeout: 5m
  slack_api_url: ${SLACK_WEBHOOK_URL}

route:
  receiver: default-warn
  group_by: [alertname, tenant_id, campaign_id]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  routes:
    - matchers: [ severity="page" ]
      receiver: pagerduty-and-slack
      group_wait: 10s
      group_interval: 5m
      repeat_interval: 4h
      continue: false
    - matchers: [ severity="warn" ]
      receiver: slack-warn
      continue: false
    - matchers: [ severity="info" ]
      receiver: email-digest
      group_interval: 6h
      repeat_interval: 24h

receivers:
  - name: default-warn
    slack_configs:
      - channel: "#vici2-alerts"
        send_resolved: true
        title: "{{ .CommonLabels.alertname }} ({{ .Status }})"
        text:  "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ .Annotations.runbook }}\n{{ end }}"

  - name: slack-warn
    slack_configs:
      - channel: "#vici2-alerts"
        send_resolved: true

  - name: pagerduty-and-slack
    pagerduty_configs:
      - service_key: ${PAGERDUTY_SERVICE_KEY}
        description: "{{ .CommonLabels.alertname }} — {{ .CommonAnnotations.summary }}"
        details:
          runbook:   "{{ .CommonAnnotations.runbook }}"
          dashboard: "{{ .CommonAnnotations.dashboard }}"
          campaign:  "{{ .CommonLabels.campaign_id }}"
    slack_configs:
      - channel: "#oncall"
        send_resolved: true
        color: danger

  - name: email-digest
    email_configs:
      - to: vici2-ops-digest@example.com
        send_resolved: false

inhibit_rules:
  # FreeSwitchDown swallows derivative alerts
  - source_matchers: [ alertname="Vici2FreeSwitchDown" ]
    target_matchers:
      - alertname=~"Vici2(ESL.*|HopperStarved|HopperFloor|DropRate.*|FSConferenceLeak|DialerOriginateLatencyHigh)"
    equal: [ fs_host ]

  # RedisDown swallows hopper alerts (hopper lives in Redis)
  - source_matchers: [ alertname="Vici2RedisDown" ]
    target_matchers:
      - alertname=~"Vici2Hopper.*"

  # MySQLDown swallows drop-rate alerts (audit numerators are in MySQL)
  - source_matchers: [ alertname="Vici2MySQLDown" ]
    target_matchers:
      - alertname=~"Vici2DropRate.*"
```

### 9.2 Maintenance windows — silence API (open-question resolution)

Maintenance windows are encoded as **Alertmanager silences** via
`amtool silence add` or POST to `/api/v2/silences`. Operators apply a
matcher (e.g. `alertname=~"Vici2.*", env="staging"`), bounded to ≤ 2 h
by default to prevent silenced-forever alerts. A wrapper script
`scripts/maintenance-window.sh start|stop` is provided in IMPLEMENT.

**Considered and rejected:** a `vici2_maintenance_active` gauge written
by deploy scripts driving `inhibit_rules`. Silence API wins on
auditability (silences carry author + reason fields) and dashboard
visibility (Alertmanager UI shows active silences).

### 9.3 PagerDuty escalation (open-question resolution)

**Phase 1 default: single team** (`vici2-oncall`). All `severity=page`
alerts route to one PagerDuty service. When/if compliance and ops
on-call diverge (Phase 4 multi-tenant or compliance officer on-call
rotation), split via routing on `compliance="true"` label →
`vici2-compliance-oncall` service.

---

## 10. Runbook skeleton — `spec/runbooks/oncall.md`

One section per PAGE alert. Every section follows this template:

```markdown
### <AlertName>

- TRIGGERED BY: <metric expr summary, threshold, for-duration>
- WHY IT MATTERS: <link to compliance section / SLO>
- FIRST CHECK: <Grafana dashboard URL + specific panel> ← within 30s
- LIKELY CAUSES: <ranked list>
- MITIGATION: <ordered steps; first step must be SAFE (silence/throttle), not destructive>
- ESCALATION: <who to wake at T+15m; default vici2-oncall second>
- POST-MORTEM REQUIRED IF: <severity threshold, e.g. compliance breach>
```

Initial set (15 PAGE alerts to cover):

1. `Vici2DropRateImminentBreach`
2. `Vici2DNCBypass`
3. `Vici2TCPAOutsideWindow`
4. `Vici2RecordingConsentMissing`
5. `Vici2FreeSwitchDown`
6. `Vici2ESLConnectionDown`
7. `Vici2HopperFloor`
8. `Vici2MySQLDown`
9. `Vici2RedisDown`
10. `Vici2HostDiskCritical`
11. `Vici2HostDown`
12. (room for 3 more added by downstream modules — `vici2_<svc>_recovered_total` helps RCA)

The runbook lives under `spec/runbooks/oncall.md` per SPEC §3.11 #7;
linked from each alert's `annotations.runbook`.

---

## 11. Hand-off interfaces (to other modules)

### 11.1 Inbound contracts (services owe O01)

- **Every long-running service** exposes `/metrics` on its documented
  port (per F01 PLAN: api 9101, dialer 9102, workers 9103). New
  services in §6.1 above: web 9108, fs-exporter 9104.
- **Metric naming convention is mandatory.** A CI grep in `make lint`
  fails on any registered metric whose name does not start with
  `vici2_` (allowed exception: process/runtime defaults like
  `process_*`, `go_*`, `nodejs_*`, exporter-native names like
  `mysql_*`, `redis_*`, `node_*`).
- **Per-module metric registration.** Each module's PLAN.md MUST list
  every metric it adds, with name, type, labels, and a one-line
  description. This requirement is added to the module template in
  SPEC §1.
- **PR template gets a "metrics added" checkbox** (SPEC §3.3 update):
  `- [ ] Metrics added to spec/modules/<id>/PLAN.md and emitted under vici2_ prefix`

### 11.2 Outbound contracts (O01 owes others)

- **Drop-rate gauge** `vici2_dialer_drop_ratio{campaign_id}` — populated
  by E05 worker via recording rule `vici2:dialer_drop_ratio_30d:rate`
  (mirrored to MySQL audit log; see §13).
- **Pre-built dashboards** (8) provisioned automatically — modules can
  reference them by UID in their HANDOFF.md (`grafana/d/<uid>`).
- **Alertmanager API** at `:9093/api/v2/silences` — modules document
  scheduled-maintenance steps in their runbook entries against this API.
- **Inhibit-rule list** — additions to `inhibit_rules` in
  `alertmanager.yml` must be PR'd against this PLAN's owners.

### 11.3 To O04 (CI/CD)

- New CI steps:
  - `promtool check config prom/prometheus.yml`
  - `promtool check rules prom/rules/*.yml`
  - `amtool check-config alertmanager/alertmanager.yml`
  - `make grafana-build` (jsonnet compile gate)
  - `scripts/cardinality-lint.sh` (forbidden-label denylist)
- All hooked into `make lint` so local + CI stay in lock-step.

---

## 12. Tracing & logging scope

- **Tracing: Phase 2 deferred.** No OpenTelemetry SDK, no OTLP
  collector, no Jaeger/Tempo in O01 v1. Trigger criteria for Phase 2
  adoption: ≥ 3 incidents/quarter where root-cause-analysis took
  > 1 hour due to lack of distributed traces.
- **Logs: separate Phase 2 module.** stdout JSON (SPEC §3.4) collected
  by Docker's default driver in Phase 1. Centralized log aggregation
  (Loki + Promtail or Grafana Alloy) is filed under a future O02-or-
  similar module ID, not folded into O01.

---

## 13. Open-question resolutions (from RESEARCH §10)

| # | Question | Resolution |
|---|---|---|
| 1 | Drop-rate denominator window | **Both:** primary signal is Prometheus 30 d rolling rate `increase(vici2_dialer_drop_window_total[30d]) / increase(vici2_dialer_originates_total[30d])` per campaign. **Audit-of-record** mirrored to MySQL by the **E05 worker** so we have defense-in-depth (Prometheus retention loss does not erase the regulatory record). The recording rule emits `vici2_dialer_drop_ratio{campaign_id}`; the alert reads that gauge. |
| 2 | Native histogram readiness across stack | **Confirmed-ready** for Phase 1: Prometheus 3.x, Grafana 11.x, Alertmanager 0.27 all support native histograms in PromQL. Classic dual-emit retained for one release cycle as a safety net; removed in a follow-up PR once dashboards are verified. |
| 3 | NHCB vs pure native for compliance histograms | **NHCB confirmed** for any histogram with a fixed regulatory cutoff (drop-rate 2 s, ESL latency SLO). Pure native everywhere else. |
| 4 | FS-exporter reconcile semantics | **Hybrid:** full snapshot every 60 s + delta event stream. On reconnect, hold last-known gauges, set `vici2_freeswitch_up=0`, swap atomically on first successful poll. See §4.3. |
| 5 | Multi-FS gauge labelling | **`fs_host` label always present** on every FS / ESL metric, even Phase 1 single-FS. Phase 4 sharding requires zero label changes. |
| 6 | Recording rule placement | **Prometheus-side** (file `prom/rules/recording/*.yml`). Portable, no Grafana coupling, reviewed in PR alongside metric/alert changes. Revisit only if Grafana-managed rules give material UX wins. |
| 7 | Alert routing to PagerDuty escalation policy | **Single team for Phase 1** (`vici2-oncall`). Future split on `compliance="true"` label when compliance-officer rotation exists. |
| 8 | Maintenance window primitive | **Alertmanager silence API** via `scripts/maintenance-window.sh` wrapper. Default ≤ 2 h bound to prevent forever-silenced alerts. |
| 9 | Loki / Phase 2 logging module ID | **Separate module** (will be filed e.g. O06 or under a new "L" track). Confirmed NOT folded into O01. |
| 10 | Tracing decision gate | **Defer.** Concrete trigger: ≥ 3 incidents/quarter where RCA took > 1 hour due to missing trace context. Tracked in `spec/runbooks/oncall.md` post-mortem template. |

---

## 14. Risks & known gaps

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Cardinality runaway** from a downstream module slipping a forbidden label past review | Medium | High | Forbidden-label CI denylist + per-metric series ceiling (10 k); PR template checkbox; allowed-label allowlist requires RFC to extend. |
| **FS-exporter ESL conflict with T01** (event subscription overlap, missed events for dialer) | Low | Medium | Exporter opens its OWN ESL connection (separate session). FS handles many ESL clients in parallel; subscriptions are independent. Documented in T01 HANDOFF. |
| **Native histogram dashboard rendering bugs** in Grafana 11.x edge cases | Low | Medium | Classic histogram dual-emit retained one release cycle; flip to pure-native only after dashboard QA. |
| **30-day TSDB on a single host disk filling up** under Phase 4 metric volume | Medium | Medium | Hosts dashboard alert `Vici2HostDiskFillingFast` (predict_linear 24 h); revisit retention or move to Mimir before reaching 80%. |
| **PagerDuty cost / noise** from over-sensitive page rules | Medium | Low | Conservative `for:` durations (1 m–30 m) on all page alerts except zero-tolerance compliance; quarterly alert-fatigue review. |
| **Alertmanager silence forever** mistakenly applied | Low | High (compliance) | Default 2 h cap in `scripts/maintenance-window.sh`; weekly cron audit of active silences > 24 h. |
| **fs-exporter Go binary diverging from T01 ESL changes** | Low | Low | Both share `dialer/internal/esl` — single source of truth for client and supervisor. PR ownership: T01 owns the package; O01 consumes. |
| **Recording rule mismatch** between Prometheus 30 d and MySQL audit numerator | Medium | High (compliance audit) | E05 worker writes the audit-of-record numerator + denominator; nightly reconciler compares Prometheus-derived ratio to MySQL ratio, alerts on > 0.001 absolute drift. |

---

## 15. Files to be created in IMPLEMENT

(O01 only; counts approximate.)

```
docker-compose.observability.yml                     1
prom/prometheus.yml                                  1
prom/rules/compliance.yml                            1
prom/rules/dialer.yml                                1
prom/rules/agents.yml                                1
prom/rules/freeswitch.yml                            1
prom/rules/mysql.yml                                 1
prom/rules/redis.yml                                 1
prom/rules/hosts.yml                                 1
prom/rules/recording/*.yml                           ~3 (filled by downstream PRs)
alertmanager/alertmanager.yml                        1
grafana/datasources/prometheus.yml                   1
grafana/provisioning/dashboards/file.yml             1
grafana/src/lib/{panels,layouts,prefixes}.libsonnet  3
grafana/src/{exec,dialer,agents,freeswitch,
            mysql,redis,hosts,compliance}.jsonnet    8
grafana/dashboards/*.json                            8 (generated, committed)
dialer/cmd/fs-exporter/{main.go,Dockerfile,README.md} 3
dialer/internal/fsexporter/*.go                      ~5
spec/runbooks/oncall.md                              1
scripts/cardinality-lint.sh                          1
scripts/cardinality-estimate.sh                      1
scripts/maintenance-window.sh                        1
.github/workflows/observability-checks.yml           1 (or merged into ci.yml)
```

~40 files total, roughly 1500 LoC across all of O01.

---

## 16. Acceptance criteria (restated from O01.md)

- [ ] All 8 services scraped within 60 s of obs overlay startup.
- [ ] 8 dashboards populate with non-empty panels.
- [ ] Forced drop% > 2.9% test → `Vici2DropRateImminentBreach` PAGE
      fires within 60 s and lands in PagerDuty + Slack `#oncall`.
- [ ] FS-exporter killed → `Vici2FreeSwitchDown` PAGE fires within 60 s
      AND inhibits `Vici2HopperStarved` / `Vici2ESLDisconnect` / drop-rate.
- [ ] All 11 PAGE alerts have a runbook entry under
      `spec/runbooks/oncall.md`.
- [ ] `make lint` passes `promtool` + `amtool` + cardinality CI.
- [ ] Grafana dashboard p95 load time < 2 s on Phase 1 fixture data
      (Lighthouse-grade per O01.md acceptance).

End of PLAN.md.
