# D07 — Lead-List Management — PLAN

**Module:** D07 (Data, Phase 1)
**Author:** D07-IMPLEMENT agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** IMPLEMENT
**Depends on (FROZEN):** F01, F02, F05, D01, D02, D04, E01
**Provides to:** M-series UI, E01 hopper, dialer

D07 owns the **List surface**: CRUD, campaign assignment, per-list
configuration, bulk operations (reset/purge/clone), and stats.
Individual lead records are D01's domain; D07 manages the containers.

---

## 0. TL;DR (10-bullet decision summary)

1. **REST surface — 8 endpoints under `/api/lists`** plus one nested
   `/api/campaigns/:id/lists` already exists in E01; D07 adds the
   list-centric surface where the list is the primary resource.
2. **List CRUD** — name, description, active, owner_user_id (nullable),
   settings JSON with `{max_attempts, recycle_delay_default,
   override_tz, callable_status_codes}`. Schema additive amendment to
   existing `lists` table via a Prisma migration.
3. **Campaign assignment** — `campaign_lists` join table already exists
   (F02 schema). D07 exposes `GET /api/lists/:id/campaigns` and
   `POST /api/lists/:id/campaigns` / `DELETE /api/lists/:id/campaigns/:cid`
   with per-assignment `priority` and `active` toggle.
4. **Stats endpoint** — `GET /api/lists/:id/stats` returns per-status
   counts, recyclable-lead count, callable-now count. Valkey 5-minute
   cache keyed `list:stats:{tenantId}:{listId}`. COUNT(*) capped at 1M
   via `LIMIT 1000001` with partial aggregation. Target: ≤200ms p99 for
   lists ≤1M leads.
5. **Reset** (`POST /api/lists/:id/reset`) — bulk `UPDATE leads SET
   status='NEW', called_count=0, last_called_at=NULL WHERE list_id=X AND
   tenant_id=Y AND deleted_at IS NULL` in batches of 1000. For >10k
   leads, enqueues a BullMQ job and returns `202 Accepted` with `job_id`;
   progress reported via SSE on `GET /api/lists/:id/reset/:jobId/progress`.
6. **Purge** (`POST /api/lists/:id/purge`) — soft-delete: `UPDATE leads
   SET status='DELETED', deleted_at=NOW() WHERE list_id=X AND
   tenant_id=Y AND deleted_at IS NULL`, also batched at 1000. Same
   >10k → BullMQ + SSE pattern as reset.
7. **Clone** (`POST /api/lists/:id/clone`) — creates a new List row then
   `INSERT INTO leads SELECT ... (new id, new list_id, new timestamps)
   FROM leads WHERE list_id=X AND deleted_at IS NULL`. Batched 1000 at
   a time for large lists. Returns new list id + lead count.
8. **RBAC** — new verbs added to the RBAC matrix:
   `list:read`, `list:write`, `list:delete`, `list:reset`, `list:purge`.
   admin+ can do all; supervisor gets `list:read` only; agents denied.
9. **Audit** — every mutation writes an `audit_log` row inside the same
   transaction as the entity write, following the C03 chain. Actions:
   `list.created`, `list.updated`, `list.deleted`, `list.reset.queued`,
   `list.reset.completed`, `list.purge.queued`, `list.purge.completed`,
   `list.cloned`, `list.campaign.linked`, `list.campaign.unlinked`.
10. **Long-running jobs** — BullMQ worker (`api/src/workers/list-ops.ts`)
    processes `list:reset` and `list:purge` jobs. Progress stored in
    Valkey as `list:job:{jobId}:progress` (JSON). SSE endpoint polls
    Valkey and streams `data:` lines. On completion, writes final audit row.

---

## 1. Schema amendments

### 1.1 New columns on `lists` (additive, no DROP)

```
lists.owner_user_id  BigInt?    @map("owner_user_id")
lists.settings       Json       @default("{}")
```

`settings` JSON shape (Zod-validated at API layer):
```json
{
  "max_attempts":           5,
  "recycle_delay_default":  600,
  "override_tz":            null,
  "callable_status_codes":  ["NEW", "NA", "B", "CALLBK"]
}
```

`owner_user_id` FK to `users.id` (nullable, soft-reference — no DB-level
FK to avoid cross-tenant risk; app layer enforces tenant match).

### 1.2 `campaign_lists` active toggle

Add `active BOOLEAN NOT NULL DEFAULT true` to `campaign_lists`.
Allows disabling a list for a campaign without removing the assignment.

### 1.3 Migration file

`api/prisma/migrations/20260513000000_d07_list_management/migration.sql`

---

## 2. File layout

```
api/src/lists/
  index.ts           — Fastify plugin registration
  schema.ts          — Zod validators (create/update/query/stats/clone)
  service.ts         — business logic (CRUD, stats, reset, purge, clone)
  audit.ts           — list-specific audit action types + auditList()
  permissions.ts     — RBAC helpers (checkListPerm, ownerFilter)
  stats.ts           — stats computation + Valkey cache layer
  jobs.ts            — BullMQ job definitions + enqueue helpers
  sse.ts             — SSE progress stream handler

api/src/workers/list-ops.ts   — BullMQ worker (reset + purge processors)

api/test/lists/
  schema.test.ts     — Zod schema unit tests
  service.test.ts    — service unit tests with stub Prisma
  routes.test.ts     — integration tests with stub Prisma + ioredis-mock
  long-ops.test.ts   — reset/purge job unit tests
```

---

## 3. RBAC additions

New verbs added to `shared/types/src/rbac.ts`:
- `list:read`   — view list details, stats, campaign assignments
- `list:write`  — create / update list
- `list:delete` — soft-delete a list
- `list:reset`  — reset all leads to NEW status
- `list:purge`  — soft-delete all leads in list

Role grants:
| Verb         | super_admin | admin | supervisor | agent | viewer |
|-------------|-------------|-------|------------|-------|--------|
| list:read   | ✓           | ✓     | ✓          | -     | ✓      |
| list:write  | ✓           | ✓     | -          | -     | -      |
| list:delete | ✓           | ✓     | -          | -     | -      |
| list:reset  | ✓           | ✓     | -          | -     | -      |
| list:purge  | ✓           | ✓     | -          | -     | -      |

`list:reset` and `list:purge` added to `SENSITIVE_VERBS`.

---

## 4. REST API surface

### 4.1 List CRUD

| Method | Path                  | Permission   | Description           |
|--------|-----------------------|--------------|-----------------------|
| GET    | /api/lists            | list:read    | Paginated list browse |
| POST   | /api/lists            | list:write   | Create list           |
| GET    | /api/lists/:id        | list:read    | Get single list       |
| PATCH  | /api/lists/:id        | list:write   | Update list fields    |
| DELETE /api/lists/:id  | list:delete  | Soft-delete list      |

### 4.2 Campaign assignment

| Method | Path                                      | Permission   |
|--------|-------------------------------------------|--------------|
| GET    | /api/lists/:id/campaigns                  | list:read    |
| POST   | /api/lists/:id/campaigns                  | list:write   |
| PATCH  | /api/lists/:id/campaigns/:campaignId      | list:write   |
| DELETE | /api/lists/:id/campaigns/:campaignId      | list:write   |

### 4.3 Stats

| Method | Path                  | Permission | Description                      |
|--------|-----------------------|------------|----------------------------------|
| GET    | /api/lists/:id/stats  | list:read  | Per-status counts, cached 5 min  |

Response shape:
```json
{
  "list_id": 42,
  "tenant_id": 1,
  "total": 95000,
  "by_status": { "NEW": 50000, "NA": 20000, "SALE": 5000, "DELETED": 0 },
  "recyclable": 3200,
  "callable_now": 1800,
  "cached_at": "2026-05-13T10:00:00Z",
  "cache_ttl_seconds": 300
}
```

### 4.4 Bulk operations

| Method | Path                              | Permission   | Description              |
|--------|-----------------------------------|--------------|--------------------------|
| POST   | /api/lists/:id/reset              | list:reset   | Batch reset to NEW       |
| POST   | /api/lists/:id/purge              | list:purge   | Batch soft-delete leads  |
| POST   | /api/lists/:id/clone              | list:write   | Clone list + leads       |
| GET    | /api/lists/:id/reset/:jobId/progress | list:read | SSE job progress stream  |
| GET    | /api/lists/:id/purge/:jobId/progress | list:read | SSE job progress stream  |

Sync threshold: ≤10,000 leads → run inline, return 200 with `{affected, duration_ms}`.
Async threshold: >10,000 leads → enqueue BullMQ job, return 202 with `{job_id, status: "queued"}`.

---

## 5. Stats computation

```sql
-- Per-status breakdown (capped)
SELECT status, COUNT(*) as cnt
FROM leads
WHERE tenant_id = ? AND list_id = ? AND deleted_at IS NULL
GROUP BY status
LIMIT 200;  -- max distinct status values

-- Total (capped at 1M + 1 for overflow detection)
SELECT COUNT(*) FROM (
  SELECT 1 FROM leads
  WHERE tenant_id = ? AND list_id = ? AND deleted_at IS NULL
  LIMIT 1000001
) sub;

-- Recyclable leads (status in recycle-eligible set, called_count < max_attempts,
-- last_called_at < NOW() - recycle_delay_default seconds)
SELECT COUNT(*) FROM leads
WHERE tenant_id = ? AND list_id = ?
  AND deleted_at IS NULL
  AND status IN (...)
  AND called_count < ?
  AND (last_called_at IS NULL OR last_called_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
LIMIT 1000001;
```

Valkey cache key: `list:stats:{tenantId}:{listId}` with 300-second TTL.
Cache is invalidated on list reset, purge, or any D01 lead mutation
publishing `vici2.lead.*` events (best-effort; stale cache is acceptable).

---

## 6. BullMQ job design

Queue name: `list-ops`

Job types:
```ts
type ListResetJob = {
  type: 'reset';
  tenantId: number;
  listId: number;
  actorUserId: number;
  requestId: string;
  batchSize: number;  // default 1000
}
type ListPurgeJob = {
  type: 'purge';
  tenantId: number;
  listId: number;
  actorUserId: number;
  requestId: string;
  batchSize: number;
}
```

Progress object stored in Valkey `list:job:{jobId}:progress` (TTL 3600s):
```json
{
  "status": "running" | "done" | "failed",
  "processed": 45000,
  "total": 95000,
  "pct": 47,
  "started_at": "...",
  "finished_at": null,
  "error": null
}
```

Worker processes batches using:
```sql
UPDATE leads SET status='NEW', called_count=0, last_called_at=NULL
WHERE tenant_id=? AND list_id=? AND deleted_at IS NULL AND id > ?
ORDER BY id ASC
LIMIT 1000;
```
(cursor-based: no full table scan on each batch)

---

## 7. SSE progress stream

`GET /api/lists/:id/{reset,purge}/:jobId/progress`

- Sets `Content-Type: text/event-stream`
- Polls Valkey key every 500ms, streams `data:{JSON}\n\n`
- Closes stream when `status` is `done` or `failed`
- Timeout: 10 minutes max

---

## 8. Performance budget

- `GET /api/lists` (paginated): ≤50ms p99
- `GET /api/lists/:id/stats`: ≤200ms p99 for lists ≤1M leads (cache hit: ≤5ms)
- Reset/purge sync (≤10k): ≤2s total
- Reset/purge async (>10k): job enqueue ≤50ms; worker throughput ≥5,000 leads/sec

---

## 9. Test plan

- `schema.test.ts` — Zod validators: valid/invalid create/update/settings
- `service.test.ts` — stub Prisma: CRUD, stats (mock Valkey), reset inline, purge inline
- `routes.test.ts` — Fastify integration: RBAC gates, 404 for wrong tenant, 200/201/202 shapes
- `long-ops.test.ts` — BullMQ worker: reset/purge batch cursor logic, progress updates, audit on completion
- All tests pass with `pnpm test` (no DB required, stub Prisma pattern)

---

## 10. Dependencies on other modules

- F05 `req.auth` for tenant + RBAC
- D01 `leads` table for reset/purge/clone operations
- D04 `statuses` for callable_now calculation (reads status rows)
- E01 `campaign_lists` join table (schema already exists)
- C03 audit chain via `audit_log` table
- F04/lib/redis for Valkey cache + job progress
