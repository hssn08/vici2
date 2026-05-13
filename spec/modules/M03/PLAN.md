# M03 — Ops/Admin Reports — PLAN

**Module:** M03 (Admin UI track, Phase 1)
**Author:** M03-IMPLEMENT agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** IMPLEMENTED — see HANDOFF.md once complete.
**Depends on (FROZEN):** F02 schema, D04 (canonical denominator SQL), M08 (M03 extends same
reporting plugin), M01 (admin shell + RBAC routing).
**Blocks:** none (ops-only)

---

## 0. TL;DR (10 bullets)

1. M03 adds three ops/admin reports as a natural extension of M08's compliance report plugin.
   All three endpoints live under `/api/admin/reports/` and share M08's auth helper pattern.
2. **Campaign Daily Performance** — per (campaign, date): calls_attempted, calls_connected,
   contacts (human_answered), sales, drops, drop_rate_pct, avg_call_duration_sec, abandon_rate.
3. **Agent Productivity** — per (user, date): calls_handled, time_ready_sec, time_paused_sec,
   time_talking_sec, time_acw_sec (wrap), sales, sales_per_hour.
4. **List Health** — per list: leads_total, leads_callable, leads_dnc, leads_tz_blocked,
   leads_no_attempts, leads_exhausted (terminal status), last_dial_at.
5. Canonical drop denominator (D04 §8.2): `SUM(s.human_answered)` — imported from
   `ReportingService`; M03 never re-implements this SQL.
6. All endpoints: per-tenant scoping via `auth.tenantId`; optional ?campaign / ?agent / ?list
   filters; ?from / ?to date range (YYYY-MM-DD, max 365 days); ?format=csv for CSV export.
7. RBAC: `report:view` for GET; `report:export` for `?format=csv`. Same permission set as M08.
8. Output: JSON by default. `Accept: text/csv` or `?format=csv` → RFC 4180 CSV with BOM.
9. BullMQ + Valkey cache: first request enqueues a background compute job; result cached 5 min
   (300 s) in Valkey under key `rpt:m03:<report>:<tenantId>:<params-hash>`. Subsequent requests
   within TTL return from cache. Cache miss triggers synchronous fallback for small date ranges.
10. Three golden integration tests (one per report) assert correct aggregation against mock data.

---

## 1. Goals and non-goals

### Goals
- Campaign daily performance report: calls_attempted, calls_connected, contacts, sales, drops,
  drop_rate, avg_call_duration, abandon_rate; per (campaign, date); date range + campaign filter.
- Agent productivity report: calls_handled, time_ready, time_paused, time_talking, time_acw,
  sales, sales_per_hour; per (agent, date); date range + agent filter.
- List health report: leads_total, callable, dnc, tz_blocked, no_attempts, exhausted,
  last_dial_at; per list; optional campaign filter.
- JSON + CSV output formats for all three.
- Valkey 5-minute cache per (tenant, report, params).
- Admin Web UI: 3 pages under `(admin)/admin/reports/` with date pickers, filterable tables.
- 1 golden integration test per report.

### Non-goals
- Real-time streaming / WebSocket push (Phase 3 wallboard is S01).
- TCPA drop-rate compliance enforcement (M08 owns FCC compliance reports).
- Materialized views / summary tables (live SQL with cache is sufficient for Phase 1).
- Multi-tenant cross-tenant aggregation (Phase 4).
- BullMQ job persistence or retry for cache warming (best-effort only in Phase 1).

---

## 2. API endpoints

| Method | Path | RBAC | Notes |
|---|---|---|---|
| `GET` | `/api/admin/reports/campaign-daily` | `report:view` | ?from&to&campaign |
| `GET` | `/api/admin/reports/campaign-daily/export.csv` | `report:export` | same params + CSV |
| `GET` | `/api/admin/reports/agent-productivity` | `report:view` | ?from&to&agent |
| `GET` | `/api/admin/reports/agent-productivity/export.csv` | `report:export` | CSV |
| `GET` | `/api/admin/reports/list-health` | `report:view` | ?campaign |
| `GET` | `/api/admin/reports/list-health/export.csv` | `report:export` | CSV |

---

## 3. Query design

### 3.1 Campaign daily performance

```sql
SELECT
    cl.campaign_id,
    DATE(cl.call_started)                              AS report_date,
    COUNT(*)                                           AS calls_attempted,
    SUM(cl.call_answered IS NOT NULL)                  AS calls_connected,
    SUM(s.human_answered)                              AS contacts,  -- FCC denominator
    SUM(s.sale)                                        AS sales,
    SUM(s.human_answered AND cl.is_drop = 1)           AS drops,
    ROUND(
      SUM(s.human_answered AND cl.is_drop = 1)
      / NULLIF(SUM(s.human_answered), 0) * 100, 2
    )                                                  AS drop_rate_pct,
    ROUND(AVG(NULLIF(cl.talk_seconds, 0)), 1)          AS avg_call_duration_sec,
    ROUND(
      SUM(cl.call_answered IS NOT NULL AND s.human_answered = 0)
      / NULLIF(SUM(cl.call_answered IS NOT NULL), 0) * 100, 2
    )                                                  AS abandon_rate_pct
FROM call_log cl
JOIN statuses s
  ON s.tenant_id = cl.tenant_id
 AND s.campaign_id = '__SYS__'
 AND s.status = cl.status
WHERE cl.tenant_id = ?
  AND cl.call_started BETWEEN ? AND ?
  [AND cl.campaign_id = ?]       -- optional filter
GROUP BY cl.campaign_id, DATE(cl.call_started)
ORDER BY report_date DESC, cl.campaign_id;
```

**Critical invariant:** denominator `SUM(s.human_answered)` as mandated by D04 PLAN §8.2.

### 3.2 Agent productivity

```sql
SELECT
    al.user_id,
    u.username,
    DATE(al.event_at)                                  AS report_date,
    SUM(al.event = 'call_end')                         AS calls_handled,
    COALESCE(SUM(CASE al.event WHEN 'ready'  THEN al.duration_sec END), 0)
                                                       AS time_ready_sec,
    COALESCE(SUM(CASE al.event WHEN 'pause'  THEN al.duration_sec END), 0)
                                                       AS time_paused_sec,
    COALESCE(SUM(CASE al.event WHEN 'call_end' THEN al.duration_sec END), 0)
                                                       AS time_talking_sec,
    COALESCE(SUM(CASE al.event WHEN 'dispo' THEN al.duration_sec END), 0)
                                                       AS time_acw_sec,
    (SELECT COUNT(*) FROM call_log cl2
       JOIN statuses s2
         ON s2.tenant_id = cl2.tenant_id
        AND s2.campaign_id = '__SYS__'
        AND s2.status = cl2.status
        AND s2.sale = 1
      WHERE cl2.tenant_id = al.tenant_id
        AND cl2.user_id = al.user_id
        AND DATE(cl2.call_started) = DATE(al.event_at)
    )                                                  AS sales,
    ROUND(
      (SELECT COUNT(*) FROM call_log cl3
         JOIN statuses s3
           ON s3.tenant_id = cl3.tenant_id
          AND s3.campaign_id = '__SYS__'
          AND s3.status = cl3.status
          AND s3.sale = 1
        WHERE cl3.tenant_id = al.tenant_id
          AND cl3.user_id = al.user_id
          AND DATE(cl3.call_started) = DATE(al.event_at)
      )
      / NULLIF(
          COALESCE(SUM(CASE al.event WHEN 'call_end' THEN al.duration_sec END), 0)
          / 3600.0, 0
      ), 2
    )                                                  AS sales_per_hour
FROM agent_log al
JOIN users u ON u.id = al.user_id
WHERE al.tenant_id = ?
  AND al.event_at BETWEEN ? AND ?
  [AND al.user_id = ?]                                -- optional filter
GROUP BY al.user_id, DATE(al.event_at)
ORDER BY report_date DESC, al.user_id;
```

*Implementation note:* The correlated subqueries for `sales` and `sales_per_hour` will be
re-written as CTEs or a single JOIN against `call_log`+`statuses` in service code for performance.

### 3.3 List health

```sql
SELECT
    l.id                                               AS list_id,
    l.name                                             AS list_name,
    cl2.campaign_id,
    COUNT(ld.id)                                       AS leads_total,
    SUM(
      ld.deleted_at IS NULL
      AND ld.status NOT IN ('DNC','INVALID','DEAD','EXCEEDED_CALL_CAP','CONSENT_NOT_OBTAINED')
      AND ld.tz_blocked = 0
      AND (ld.called_count = 0 OR s.recycle_delay_seconds != -1)
    )                                                  AS leads_callable,
    SUM(ld.status = 'DNC' OR EXISTS (
        SELECT 1 FROM dnc d
         WHERE d.tenant_id = ld.tenant_id
           AND d.phone_e164 = ld.phone_e164
    ))                                                 AS leads_dnc,
    SUM(ld.tz_blocked = 1)                             AS leads_tz_blocked,
    SUM(ld.called_count = 0)                           AS leads_no_attempts,
    SUM(s.recycle_delay_seconds = -1)                  AS leads_exhausted,
    MAX(ld.last_called_at)                             AS last_dial_at
FROM lists l
JOIN campaign_lists cl2 ON cl2.list_id = l.id AND cl2.tenant_id = l.tenant_id
JOIN leads ld ON ld.list_id = l.id AND ld.tenant_id = l.tenant_id AND ld.deleted_at IS NULL
LEFT JOIN statuses s
       ON s.tenant_id = ld.tenant_id
      AND s.campaign_id = '__SYS__'
      AND s.status = ld.status
WHERE l.tenant_id = ?
  [AND cl2.campaign_id = ?]                           -- optional filter
GROUP BY l.id, l.name, cl2.campaign_id
ORDER BY l.name;
```

---

## 4. Valkey cache

Cache key: `rpt:m03:<report>:<tenantId>:<sha256(sorted-params)>`
TTL: 300 seconds (5 minutes).
Implementation: Valkey `SETEX` / `GET` using the existing `lib/redis.ts` client pattern.
On cache miss: run SQL synchronously for date ranges ≤ 90 days; enqueue BullMQ job for longer.
BullMQ job: `m03-report-warm` queue; stores result in Valkey when done; no retry (best-effort).

---

## 5. CSV output format

- RFC 4180; UTF-8 with BOM (`﻿`) for Excel compatibility.
- First row: column headers in snake_case matching JSON field names.
- Filename header: `Content-Disposition: attachment; filename="<report>-<from>-<to>.csv"`.
- Dates in ISO 8601 (YYYY-MM-DD); numbers unquoted; null → empty cell.
- All CSV handlers share a single `toCsv(headers, rows)` utility in `lib/csv.ts`.

---

## 6. Web UI

Three pages under `web/src/app/(admin)/admin/reports/`:

| Page | Path | Components |
|---|---|---|
| Campaign Daily | `campaign-daily/page.tsx` | DateRangePicker, CampaignFilter, DataTable, ExportButton |
| Agent Productivity | `agent-productivity/page.tsx` | DateRangePicker, AgentFilter, DataTable, ExportButton |
| List Health | `list-health/page.tsx` | CampaignFilter, DataTable, ExportButton |

All pages: client components (`'use client'`); fetch via `useSWR`; loading skeleton;
empty-state message. No chart library required for Phase 1 (table-only; charts deferred to M08).

---

## 7. RBAC

- `report:view` — supervisor, admin, super_admin.
- `report:export` — admin, super_admin.
- Same permission grants as M08 (already in `@vici2/types` ROLE_PERMISSIONS).

---

## 8. Files to create

### 8.1 API

```
api/src/ops-reports/
  service.ts               — OpsReportService: 3 query methods + CSV helpers
  cache.ts                 — Valkey get/set wrapper (300s TTL)
  handlers/
    campaign-daily.ts      — GET handler + CSV export
    agent-productivity.ts  — GET handler + CSV export
    list-health.ts         — GET handler + CSV export
  metrics.ts               — Prometheus counters (request, cache-hit, cache-miss)
  index.ts                 — Fastify plugin: route registration

api/src/lib/csv.ts         — toCsv(headers, rows): string utility (shared M08+M03)
```

### 8.2 Web UI

```
web/src/app/(admin)/admin/reports/
  page.tsx                           — Reports index (links to sub-reports)
  campaign-daily/page.tsx            — Campaign daily report page
  agent-productivity/page.tsx        — Agent productivity report page
  list-health/page.tsx               — List health report page

web/src/components/admin/reports/
  DateRangePicker.tsx
  ReportTable.tsx
  ExportButton.tsx
```

### 8.3 Tests

```
api/test/ops-reports/
  service.test.ts          — unit: query logic (mock prisma)
  golden-campaign.test.ts  — golden: campaign-daily denominator parity
  golden-agent.test.ts     — golden: agent productivity aggregation
  golden-list.test.ts      — golden: list health counts
  cache.test.ts            — Valkey cache hit/miss
```

---

## 9. Test plan

- **golden-campaign**: 10 calls, 6 human-answered, 1 drop → drop_rate = 1/6 = 16.67%.
  Assert `contacts = 6`, `drop_rate_pct = 16.67`, `calls_attempted = 10`.
- **golden-agent**: 3 calls handled, 1 sale, 2h talking → sales_per_hour = 0.5.
- **golden-list**: 100 leads, 5 DNC, 3 tz_blocked, 20 no-attempts, 10 exhausted (recycle=-1).
  Assert counts match.

---

## 10. Acceptance criteria

- [ ] `GET /api/admin/reports/campaign-daily?from&to&campaign` returns correct aggregation.
- [ ] `GET /api/admin/reports/agent-productivity?from&to&agent` returns correct aggregation.
- [ ] `GET /api/admin/reports/list-health?campaign` returns correct counts.
- [ ] `?format=csv` returns RFC 4180 CSV with BOM; `Content-Disposition` header set.
- [ ] All three golden tests pass.
- [ ] RBAC: `report:view` required; `report:export` for CSV.
- [ ] Valkey cache hit returns within 5ms (cache warm).
- [ ] pnpm test, pnpm typecheck, pnpm lint all pass.
- [ ] Web UI pages render with date pickers, tables, and export buttons.

---

End of PLAN.md.
