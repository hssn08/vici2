# X04 — Number Pool + Rotation: HANDOFF

| Field       | Value                                    |
|-------------|------------------------------------------|
| Status      | IMPLEMENTED                              |
| Implemented | 2026-05-13                               |

---

## What Was Built

### 1. Database Migration
- `api/prisma/migrations/20260513300000_x04_number_pools/migration.sql`
  - `number_pools` table with strategy, quarantine thresholds, daily cap, concurrent cap
  - `number_pool_dids` join table with health stats, quarantine fields, area code denormalization
  - `campaigns.number_pool_id FK` amendment

### 2. Prisma Schema
- `NumberPool` model (`@@map("number_pools")`)
- `NumberPoolDid` model (`@@map("number_pool_dids")`)
- `Campaign.numberPoolId` nullable FK to `NumberPool`
- `DidNumber.numberPoolDids` back-relation
- New enums: `PoolStrategy`, `QuarantineReason`, `AttestLevel`

### 3. API Layer (12 endpoints)
`api/src/routes/admin/number-pools/`
- `schema.ts` — Zod validators, TypeScript interfaces
- `service.ts` — Pool CRUD (list, get, create, update, soft delete with campaign-reference check)
- `did-service.ts` — DID membership, quarantine/unquarantine, per-number stats
- `stats-service.ts` — Pool-level aggregate stats
- `index.ts` — Route registration (requirePermission for `number_pool:read`/`number_pool:edit`)

Registered via `api/src/routes/admin/index.ts`.

### 4. RBAC
`shared/types/src/rbac.ts` additions:
- Verbs: `number_pool:read`, `number_pool:edit`
- super_admin, admin: both verbs
- supervisor, viewer: read-only
- agent, integrator: no access

### 5. Audit Events
`api/src/auth/audit.ts` additions:
- `number_pool.created`, `.updated`, `.deleted`
- `number_pool.did.added`, `.removed`, `.quarantined`, `.unquarantined`

### 6. Valkey Key Namespace
`dialer/internal/valkey/keys.go` additions:
- `PoolRRCursor(poolID)` — round-robin cursor
- `PoolMembers(poolID)` — cached member list JSON
- `PoolInvalidate(poolID)` — pub/sub invalidation channel
- `DIDDailyCalls(didID)` — daily call counter with midnight TTL
- `DIDConcurrent(didID)` — concurrent active call counter

### 7. Go Pool Picker Package
`dialer/internal/pool/`:
- `types.go` — PoolMember, PoolConfig, PickRequest, PickResult
- `picker.go` — Service, PickFromPool (4 strategies), Release, filterMembers, incrDailyCounter
- `cache.go` — In-process member cache (5-min TTL + pub/sub invalidation)
- `metrics.go` — vici2_pool_pick_total, vici2_pool_pick_empty_total, pool_cache_hits/reloads
- `picker_test.go` — 8 unit tests, all passing

### 8. Caller-ID Waterfall (Tier 3 wired)
`dialer/internal/originate/cid_picker.go`:
- Signature changed to `PickCallerID(ctx, req, poolSvc PoolPicker)`
- Tier 3 now calls `poolSvc.PickFromPool(ctx, req)` when `NumberPoolID != 0`
- Falls through to Tier 4 on `ErrPoolEmpty`

`dialer/internal/originate/request.go`:
- Added `NumberPoolID int64`, `LocalPresenceAreaCode string`

`dialer/internal/originate/gate.go`:
- Added `PoolNPID int64` to `GateScratch`

`dialer/internal/originate/chanvars.go`:
- Added `vici2_pool_npid` channel var when pool was used

`dialer/internal/originate/originate.go`:
- Added `PoolSvc PoolPicker` to Opts, `poolSvc` field to Service

### 9. Workers Quarantine Reaper
`workers/src/jobs/number-pool-reaper/`:
- `reaper.ts` — AR + CR threshold evaluation, health score computation, pool size check
- `metrics.ts` — reaperQuarantined, reaperRun, reaperBelowMin gauges
- `index.ts` — BullMQ job registration helper

Wired into `workers/src/index.ts` as hourly cron (`0 * * * *`).

### 10. Admin UI
`web/src/app/(admin)/admin/number-pools/`:
- `page.tsx` — Pool list (name, strategy, active/quarantined DIDs, actions)
- `new/page.tsx` — Create pool form
- `[id]/page.tsx` — Pool detail with DID member table + quarantine/unquarantine actions
- `[id]/edit/page.tsx` — Edit pool settings

---

## Interface Contract for X05 (Local Presence)

```go
// X05 calls PickFromPool with AreaCodeHint set to the 3-digit area code
// of the destination number (destE164[2:5] for US +1NXXNXXXXXX).
// If no pool member matches the area code, ErrPoolEmpty is returned.
poolSvc.PickFromPool(ctx, pool.PickRequest{
    PoolID:       campaignNumberPoolID,
    TenantID:     tenantID,
    AreaCodeHint: destE164[2:5], // e.g. "415"
})
```

Pool members store `area_code CHAR(3)` (denormalized from DID E.164 on insert).

---

## API Summary

| Method | Path                                                      | Permission         |
|--------|-----------------------------------------------------------|--------------------|
| GET    | /api/admin/number-pools                                   | number_pool:read   |
| POST   | /api/admin/number-pools                                   | number_pool:edit   |
| GET    | /api/admin/number-pools/:id                               | number_pool:read   |
| PATCH  | /api/admin/number-pools/:id                               | number_pool:edit   |
| DELETE | /api/admin/number-pools/:id                               | number_pool:edit   |
| GET    | /api/admin/number-pools/:id/dids                          | number_pool:read   |
| POST   | /api/admin/number-pools/:id/dids                          | number_pool:edit   |
| DELETE | /api/admin/number-pools/:id/dids/:didId                   | number_pool:edit   |
| GET    | /api/admin/number-pools/:id/dids/:didId/stats             | number_pool:read   |
| POST   | /api/admin/number-pools/:id/dids/:didId/quarantine        | number_pool:edit   |
| POST   | /api/admin/number-pools/:id/dids/:didId/unquarantine      | number_pool:edit   |
| GET    | /api/admin/number-pools/:id/stats                         | number_pool:read   |

---

## Metric Definitions

- **answer_rate_7d**: `answer_count_7d / call_count_7d` (0 if call_count_7d == 0).
  A "live answer" is a call where `billsec >= 4`.
- **complaint_proxy_rate_30d**: `short_call_count_30d / call_count_30d`.
  A "short call" is a human-answered call (billsec > 0) with `billsec < 4`.
- **health_score**: composite [0–100]; see reaper.ts `computeHealthScore()`.
- **daily_call_count**: Valkey `t:{tid}:did:{did_id}:daily_calls` INT, TTL midnight UTC.
- **concurrent_calls**: Valkey `t:{tid}:did:{did_id}:concurrent` INT, incremented on pick,
  decremented via `pool.Release()` called from CHANNEL_HANGUP_COMPLETE handler.

---

## Known Limitations / Follow-ups

1. **Live Valkey counters in API stats**: `dailyCallCount` and `concurrentCalls` in DID member
   responses are stubbed to 0. Real values require wiring the API server to Valkey.

2. **Call outcome recording**: The `vici2_pool_npid` channel var is set but the
   FreeSWITCH event router does not yet increment `call_count_7d` / `answer_count_7d`.
   This is described in PLAN §7.6 and should be wired in X05's sprint.

3. **Campaign pool UI**: Campaign edit page pool selector (PLAN §9.5) was not implemented
   as it requires modifying the existing T02 campaign edit page.
