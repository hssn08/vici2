# O01 — Observability — HANDOFF

**Module:** O01
**Branch:** `feat/O01-implement` (NOT pushed; NOT merged)
**Date:** 2026-05-13
**Status:** READY FOR REVIEW.

This hand-off documents what downstream modules can rely on, what
downstream modules owe O01, and the deferred items that must be picked
up before O01 closes.

---

## 1. What downstream modules can rely on

### 1.1 Endpoints (FROZEN — changes require RFC)

| Endpoint                      | Purpose                                   |
|-------------------------------|-------------------------------------------|
| `http://prometheus:9090`      | Prometheus 3.x server (inside compose net) |
| `http://localhost:9090`       | Same, from host                            |
| `http://alertmanager:9093`    | Alertmanager 0.27 (inside compose net)     |
| `http://localhost:9093`       | Same, from host                            |
| `http://grafana:3000`         | Grafana 11.x (inside compose net)          |
| `http://localhost:3001`       | Grafana from host (port 3000 is api's)     |
| `http://api:3000/internal/alerts/webhook` | Phase 1 Alertmanager webhook receiver — **api must implement** (see §3 owed) |

### 1.2 Recording-rule outputs available for dashboards & alerts

- `vici2_dialer_drop_ratio{campaign_id}` — 30-day rolling. E05 worker
  mirrors the audit-of-record to MySQL; this gauge is the operational
  signal.
- `vici2:dialer_originate_latency_p95:5m{campaign_id, le}`
- `vici2:dialer_originate_latency_p99:5m{campaign_id, le}`
- `vici2:dialer_originates_rate:5m{campaign_id}`
- `vici2:dialer_bridged_rate:5m{campaign_id}`
- `vici2:agent_state_count:by_state{state}`
- `vici2:agent_calls_handled_rate:5m{disposition}`
- `vici2:freeswitch_calls_active:sum`
- `vici2:esl_event_latency_p99:5m{fs_host, event_type, le}`
- `vici2:api_request_duration_p95:5m{route, le}`
- `vici2:api_error_rate_5xx:5m`

### 1.3 Grafana dashboard UIDs (stable, referenceable from runbooks)

`exec`, `dialer`, `api`, `agents`, `freeswitch`, `mysql`, `redis`,
`hosts`, `compliance`.

### 1.4 Alert names (FROZEN public interface)

30 alerts across 7 files; see `infra/observability/prometheus/rules/`.
Severities: `page` | `warn` | `info`. Routing on `severity` label.

### 1.5 Cardinality contract

- Forbidden label list (CI-blocking): see
  `scripts/ci/cardinality-lint.sh`.
- All metrics MUST be named `vici2_<subsystem>_<unit>`.
- Adding a new label outside the allowed list requires an RFC.

---

## 2. Inbound contract — what downstream modules MUST do

### 2.1 F01-derived modules (api / dialer / workers / web)

Already in place per F01 HANDOFF (`/metrics` on 9101 / 9102 / 9103 / web-side
`/api/metrics`). New requirement from O01: any new metric registered
in those services MUST:

- Use the `vici2_<subsystem>_<unit>` naming convention.
- Carry only labels from the allowed list (PLAN §5.2).
- Be listed in the module's PLAN.md alongside name / type / labels /
  description.
- Pass `scripts/ci/cardinality-lint.sh` (no forbidden labels).

### 2.2 Per-module PR checklist (proposed addition to PR template)

```
- [ ] Metrics added (if any) are listed in spec/modules/<id>/PLAN.md
- [ ] All new metrics use vici2_ prefix
- [ ] cardinality-lint passes locally
- [ ] If a new dashboard panel is needed, file an RFC against O01
```

### 2.3 E05 (drop-rate audit worker)

E05 owes O01:

- Populate `vici2_dialer_drop_window_total{campaign_id, reason}`
  (numerator) and `vici2_dialer_originates_total{campaign_id, ...}`
  (denominator). The recording rule
  `vici2_dialer_drop_ratio{campaign_id}` is derived from these.
- Mirror the same numerator/denominator pair to MySQL as the
  audit-of-record so Prometheus retention loss does not erase the
  regulatory record (PLAN §13 #1).
- A nightly reconciler that compares Prometheus-derived ratio to MySQL
  ratio and alerts on > 0.001 absolute drift (deferred; not in O01).

### 2.4 T01 / fs-exporter (in-house exporter — DEFERRED)

PLAN §4 specifies the `freeswitch-exporter` Go binary
(`dialer/cmd/fs-exporter/`). **It is NOT built in this implementation.**
Scrape job `vici2-fs-exporter` is configured in `prometheus.yml` so
the slot is reserved; the exporter binary itself is a separate
IMPLEMENT phase that lives in module T01 or its own ticket.

---

## 3. What O01 owes (outbound)

- The Alertmanager webhook receiver currently POSTs to
  `http://api:3000/internal/alerts/webhook?severity=<level>`.
  **api MUST implement this endpoint.** Phase 1 behaviour: write the
  alert payload to `audit_log` for human review. Phase 2 swap for
  PagerDuty/Slack happens by uncommenting receiver blocks and supplying
  secrets via env.
- 9 provisioned Grafana dashboards (auto-loaded on Grafana boot).
- Recording rules listed in §1.2.
- Inhibit rules: `FreeSwitchDown` swallows ESL+hopper+drop-rate;
  `RedisDown` swallows hopper; `MySQLDown` swallows drop-rate.

---

## 4. Tracing / logging scope (explicit deferral)

Per PLAN §12 + RESEARCH §8:

- **Tracing (OTel Collector / Tempo / Jaeger):** DEFERRED to Phase 2.
  Trigger: ≥ 3 incidents/quarter where RCA took > 1 hour due to lack
  of distributed traces.
- **Centralised log aggregation (Loki / Promtail / Alloy):** DEFERRED
  to a separate Phase 2 module (filed elsewhere, NOT folded into O01).

The parent IMPLEMENT brief mentioned OTel/Loki/Tempo. Those are not in
this branch by design — the O01 PLAN explicitly scoped them out, the
sister module(s) own them. If the orchestrator wants them in Phase 1,
that requires re-opening the PLAN.

---

## 5. Deferred / known gaps

| # | Item | Owner | Notes |
|---|---|---|---|
| 1 | `freeswitch-exporter` Go binary (PLAN §4) | T01 IMPLEMENT or separate ticket | Job slot pre-wired in `prometheus.yml`. |
| 2 | `spec/runbooks/oncall.md` runbook entries for the 11 PAGE alerts | Future runbooks module | Each rule's `runbook:` annotation already points at the planned anchor. |
| 3 | `make lint` integration (promtool / amtool / cardinality) | O04 (CI/CD) | Scripts exist and pass; not yet plumbed into the Makefile target. |
| 4 | `scripts/maintenance-window.sh` (Alertmanager silence wrapper, PLAN §9.2) | Future infra ticket | Operators can use raw `amtool` in the meantime. |
| 5 | PagerDuty + Slack receivers | Phase 2 | Commented-out blocks scaffolded in `alertmanager.yml`; require secrets rollout. |
| 6 | Native-histogram dual-emit removal | After 1 release cycle | Currently keep classic dual-emit as safety net. |
| 7 | `api:3000/internal/alerts/webhook` handler | F01-derived API work | Phase 1 receiver target. |
| 8 | Cardinality estimator (`scripts/cardinality-estimate.sh`, PLAN §5.3 #4) | O04 | Requires fixture metrics to scrape against. |
| 9 | grafonnet authoring (`.libsonnet` source, PLAN §8.1) | Future ticket | Dashboards are checked-in JSON in this implementation; grafonnet rebuild is a nice-to-have once panels stabilise. |
| 10 | OTel tracing + Loki | Phase 2 / separate module | Out of scope per PLAN §12. |

---

## 6. How to run / verify locally

```bash
# 1. Ensure .env exists (cp .env.example .env if missing).
# 2. Boot just the obs stack:
docker compose -f docker-compose.dev.yml up -d \
  prometheus alertmanager grafana node-exporter

# 3. Health checks:
curl -sf http://localhost:9090/-/healthy
curl -sf http://localhost:9093/-/healthy
curl -sf http://localhost:3001/api/health

# 4. Open Grafana: http://localhost:3001 (admin / admin by default).
# 5. See VERIFY.md §3 for the full target-status / rules / dashboards
#    verification command set.
```

---

## 7. Files committed by this module

```
infra/observability/                              (16 files)
docker-compose.dev.yml                            (+6 services)
.env.example                                      (+11 env vars)
scripts/ci/cardinality-lint.sh                    (+1 script)
spec/modules/O01/VERIFY.md                        (this file's sibling)
spec/modules/O01/HANDOFF.md                       (this file)
```

End of HANDOFF.md.
