# O03 — Alerting + On-Call Paging Integrations — PLAN

**Module:** O03
**Branch:** `feat/O03-implement`
**Date:** 2026-05-13
**Status:** IMPLEMENTING
**Depends on:** O01 (Alertmanager webhook receiver stub), F05 (auth/RBAC/audit_log)

---

## 0. TL;DR

O03 wires Alertmanager's webhook → a per-tenant fan-out engine that
delivers fired alerts to Slack, PagerDuty Events API v2, and generic
webhooks. Every receiver is persisted in a new `alert_receivers` table.
Delivery uses BullMQ (exponential backoff, 3 attempts). Every fired
alert and every delivery outcome is audit-logged. An admin CRUD API plus
a test-fire endpoint expose the system to operators.

---

## 1. Scope

| Area | Deliverable |
|------|-------------|
| DB schema | `alert_receivers` table (new migration) |
| RBAC | `alert:read` + `alert:configure` verbs in shared/types |
| API — internal | `POST /internal/alerts/webhook` — receive Alertmanager firings |
| API — admin CRUD | `GET/POST /api/admin/alert-receivers` + `GET/PATCH/DELETE /api/admin/alert-receivers/:id` |
| API — test fire | `POST /api/admin/alert-receivers/:id/test` |
| Delivery worker | BullMQ queue `vici2:queue:alert-delivery`, 3 attempts exp-backoff |
| Receivers | Slack incoming webhook, PagerDuty Events v2, generic HTTP webhook |
| Routing rules | severity=page → pagerduty+slack; severity=warn → slack; severity=info → skip |
| Maintenance window | `scripts/maintenance-window.sh` (amtool silence wrapper) |
| Audit | Every Alertmanager payload receipt + every delivery attempt → `audit_log` |
| Metrics | `vici2_alert_deliveries_total{receiver_id, kind, result}`, `vici2_alert_delivery_latency_seconds{kind}`, `vici2_alert_delivery_failures_total{kind}` |
| Admin UI stub | `web/src/app/(admin)/alert-receivers/` page (list + form) |
| Tests | Vitest unit tests with mocked HTTP; webhook signature validation |
| Infra config | Alertmanager `alertmanager.yml` updated: webhook receiver → `http://api:3000/internal/alerts/webhook` |

---

## 2. Database schema

### 2.1 `alert_receivers` table

```sql
CREATE TABLE alert_receivers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED NOT NULL DEFAULT 1,
  name           VARCHAR(128)    NOT NULL,
  kind           ENUM('slack','pagerduty','webhook') NOT NULL,
  config         JSON            NOT NULL,
  active         BOOLEAN         NOT NULL DEFAULT TRUE,
  severity_filter SET('page','warn','info') NOT NULL DEFAULT 'page,warn,info',
  created_at     DATETIME(6)     NOT NULL DEFAULT NOW(6),
  updated_at     DATETIME(6)     NOT NULL DEFAULT NOW(6) ON UPDATE NOW(6),
  PRIMARY KEY (id),
  INDEX idx_ar_tenant_kind (tenant_id, kind),
  INDEX idx_ar_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`config` shape by `kind`:
- `slack`: `{ url: string }` (incoming webhook URL)
- `pagerduty`: `{ routing_key: string }` (Events API v2 integration key)
- `webhook`: `{ url: string, secret?: string, method?: 'POST'|'PUT', headers?: Record<string,string> }`

### 2.2 Prisma model

```prisma
enum AlertReceiverKind {
  slack
  pagerduty
  webhook
}

model AlertReceiver {
  id             BigInt             @id @default(autoincrement())
  tenantId       BigInt             @default(1) @map("tenant_id")
  name           String             @db.VarChar(128)
  kind           AlertReceiverKind
  config         Json
  active         Boolean            @default(true)
  severityFilter String             @default("page,warn,info") @map("severity_filter") @db.VarChar(32)
  createdAt      DateTime           @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt      DateTime           @updatedAt @map("updated_at") @db.DateTime(6)

  @@index([tenantId, kind], map: "idx_ar_tenant_kind")
  @@index([tenantId, active], map: "idx_ar_tenant_active")
  @@map("alert_receivers")
}
```

---

## 3. RBAC

Add two verbs to `shared/types/src/rbac.ts`:

| Verb | Description |
|------|-------------|
| `alert:read` | List receivers + view delivery history |
| `alert:configure` | Create/update/delete receivers, send test alert |

Grant matrix:
- `super_admin`: both verbs, scope=tenant
- `admin`: both verbs, scope=tenant
- `supervisor`: `alert:read`, scope=group
- `viewer`: `alert:read`, scope=tenant
- `agent`, `integrator`: no alert verbs

---

## 4. API endpoints

### 4.1 Internal — receive Alertmanager webhook

```
POST /internal/alerts/webhook
```

- Protected by `X-Internal-Secret` header (same pattern as I01 queue routes).
- Accepts Alertmanager v4 webhook payload (`{ receiver, status, alerts[], ... }`).
- For each alert in the payload:
  - Extracts `severity` from `labels.severity` (default `warn`).
  - Applies severity routing: `page` → all active receivers with page in `severity_filter`; `warn` → all with warn; `info` → skip.
  - Enqueues one BullMQ job per receiver (queue: `vici2:queue:alert-delivery`).
  - Writes ONE `audit_log` row: `action=alert.received`, `entity_type=alert`, `entityId=alertname`.
- Returns `{ queued: N }` synchronously.

### 4.2 Admin CRUD

All routes under `/api/admin/alert-receivers`. RBAC: `alert:configure` (write), `alert:read` (read).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/alert-receivers` | List all receivers for tenant |
| POST | `/api/admin/alert-receivers` | Create receiver |
| GET | `/api/admin/alert-receivers/:id` | Get receiver by ID |
| PATCH | `/api/admin/alert-receivers/:id` | Update receiver |
| DELETE | `/api/admin/alert-receivers/:id` | Soft-delete (set active=false) |
| POST | `/api/admin/alert-receivers/:id/test` | Send test alert firing |

Config JSON is never returned in full (mask `routing_key`, `secret` with `***`).

### 4.3 Test-fire endpoint

`POST /api/admin/alert-receivers/:id/test`:
- Builds a synthetic Alertmanager firing payload.
- Enqueues a single delivery job (marks job data with `isTest: true`).
- Returns `{ jobId, queued: true }`.

---

## 5. Delivery worker (BullMQ)

Queue name: `vici2:queue:alert-delivery`

**Job payload:**
```ts
{
  tenantId: number;
  receiverId: bigint;
  kind: 'slack' | 'pagerduty' | 'webhook';
  config: unknown;          // decrypted at enqueue time from DB row
  alert: AlertmanagerAlert; // single alert object
  severity: string;
  isTest: boolean;
}
```

**Retry policy:** 3 attempts, exponential backoff (2^attempt × 1000ms base: 1s, 2s, 4s).

**Per-kind delivery:**

- **Slack**: `POST {config.url}` with body `{ text, attachments }`. Checks HTTP 200.
- **PagerDuty**: `POST https://events.pagerduty.com/v2/enqueue` with `{ routing_key, event_action, payload }`. Checks HTTP 202.
- **Webhook**: `POST {config.url}` with full alert JSON + HMAC-SHA256 signature header `X-Vici2-Signature` if `config.secret` set.

**After each attempt** (success or final failure): write `audit_log` row:
- `action=alert.delivered` (success) or `action=alert.delivery_failed`
- `entity_type=alert_receiver`, `entityId=receiverId`
- `afterJson: { kind, alertname, severity, attempt, latencyMs, httpStatus? }`

**Metrics** incremented in the worker:
- `vici2_alert_deliveries_total{kind, result}` — counter
- `vici2_alert_delivery_latency_seconds{kind}` — histogram
- `vici2_alert_delivery_failures_total{kind}` — counter

---

## 6. Maintenance window script

`scripts/maintenance-window.sh` — wraps `amtool silence add/expire`:

```bash
# Usage:
#   scripts/maintenance-window.sh start [duration_minutes] [matcher...]
#   scripts/maintenance-window.sh stop  [silence_id]
#   scripts/maintenance-window.sh list
```

- Default duration: 120 minutes (PLAN §9.2 of O01 — never-silent cap).
- Records silence ID to `.alertmanager-silence-id` for `stop`.
- Prints silence ID on start.

---

## 7. Admin UI

`web/src/app/(admin)/alert-receivers/`

- `page.tsx` — list of receivers (name, kind, active badge, last test date).
- `new/page.tsx` — create form.
- `[id]/page.tsx` — edit form + test button.

Minimal: server-fetched data via `fetch('/api/admin/alert-receivers')`, client-side form with `kind` selector and dynamic config fields.

---

## 8. Tests

File: `api/test/alerts/alert-receivers.test.ts`

Tests:
1. Webhook receiver endpoint accepts valid Alertmanager payload, returns `{ queued: N }`.
2. Webhook receiver rejects missing `X-Internal-Secret`.
3. CRUD: create receiver → get → update → test → delete.
4. Delivery worker: Slack delivery success (mocked fetch → 200).
5. Delivery worker: PagerDuty delivery success (mocked fetch → 202).
6. Delivery worker: Generic webhook delivery with HMAC signature validation.
7. Delivery worker: retry on transient failure (mock 500 → 500 → 200, expect 3 attempts).
8. Severity routing: `info` alerts are skipped (not enqueued).
9. Maintenance window script: start produces amtool command with correct duration.

---

## 9. Metrics (new, added to O01 conventions)

```
vici2_alert_deliveries_total{kind, result}    counter
vici2_alert_delivery_latency_seconds{kind}    histogram (native)
vici2_alert_delivery_failures_total{kind}     counter
```

Labels: `kind` ∈ {slack, pagerduty, webhook}, `result` ∈ {success, failed}.
All are within the allowed label list from O01 §5.2.

---

## 10. Deferred

| Item | Notes |
|------|-------|
| Per-tenant PagerDuty escalation policy routing | Phase 2 — split on `compliance="true"` label |
| Email digest receiver | Phase 2 — depends on W01 email delivery |
| Alertmanager native Slack/PD receivers | O01 scaffolded them; O03 builds the API-fan-out layer instead |
| Receiver config encryption (KEK wrap) | Phase 2 — routing_key is sensitive; current: store plain in JSON; operators must restrict DB access |
| Web UI polish (React Query, optimistic updates) | Phase 2 |

---

## 11. Files to be created

```
api/prisma/migrations/20260513230000_o03_alert_receivers/migration.sql
api/src/routes/internal/alerts.ts
api/src/routes/admin/alert-receivers/index.ts
api/src/routes/admin/alert-receivers/schema.ts
api/src/routes/admin/alert-receivers/service.ts
api/src/workers/alert-delivery.ts
api/test/alerts/alert-receivers.test.ts
scripts/maintenance-window.sh
web/src/app/(admin)/alert-receivers/page.tsx
web/src/app/(admin)/alert-receivers/new/page.tsx
web/src/app/(admin)/alert-receivers/[id]/page.tsx
```

Modified:
```
api/prisma/schema.prisma                   (AlertReceiverKind enum + AlertReceiver model)
api/src/server.ts                          (register internal alerts + admin alert-receivers routes)
api/src/routes/admin/index.ts             (register alert-receivers routes)
shared/types/src/rbac.ts                  (alert:read, alert:configure verbs + matrix)
api/vitest.config.ts                      (add coverage for alert routes)
infra/observability/alertmanager/alertmanager.yml  (webhook URL updated)
```

---

## 12. Acceptance criteria

- [ ] `POST /internal/alerts/webhook` returns `{ queued: N }` for valid Alertmanager payload.
- [ ] CRUD for alert_receivers works (create/list/get/update/delete).
- [ ] Test-fire endpoint enqueues delivery job.
- [ ] Delivery worker sends correct HTTP requests to mocked Slack + PagerDuty + webhook.
- [ ] Exponential backoff: 3 attempts on failure.
- [ ] Every alert receipt + delivery attempt is in `audit_log`.
- [ ] `pnpm typecheck` clean in api + shared.
- [ ] `pnpm test` passes (mocked HTTP).
- [ ] `scripts/maintenance-window.sh start 60` prints amtool invocation.
- [ ] `vici2_alert_deliveries_total` metric exported on `/metrics`.

End of PLAN.md.
