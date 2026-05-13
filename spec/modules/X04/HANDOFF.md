# X04 — Number Pool + Rotation: Handoff

## Status

NOT_STARTED (spec complete; awaiting implementation agent)

## Key Deliverables for Implementer

- Migration: `api/prisma/migrations/20260513300000_x04_number_pools/migration.sql`
- API routes: `api/src/routes/admin/number-pools/`
- Go pool picker: `dialer/internal/pool/`
- Valkey key additions: `dialer/internal/valkey/keys.go`
- Originate tier 3 wiring: `dialer/internal/originate/cid_picker.go`
- Workers reaper: `workers/src/jobs/number-pool-reaper/`
- RBAC: `shared/types/src/rbac.ts` (add `number_pool:read`, `number_pool:edit`)
- UI: `web/src/app/(admin)/number-pools/`

## How X05 Builds on This

X05 (local-presence) calls `pool.PickFromPool(ctx, pool.PickRequest{AreaCodeHint: areaCode3})`.
X04 filters pool members by `area_code CHAR(3)` (stored on `number_pool_dids`). If no member
matches the area code, X04 returns `ErrPoolEmpty` and X05 falls back to unfiltered pool pick
or campaign CID.

## Metric Definitions

- **answer_rate_7d**: `answer_count_7d / call_count_7d` (0 if call_count_7d == 0).
  A "live answer" is a call where `billsec >= 4`.
- **complaint_proxy_rate_30d**: `short_call_count_30d / call_count_30d`.
  A "short call" is a human-answered call (billsec > 0) with `billsec < 4`.
- **health_score**: composite [0–100]; see PLAN §8.1 `computeHealthScore()`.
- **daily_call_count**: Valkey `t:{tid}:did:{did_id}:daily_calls` INT, TTL midnight UTC.
- **concurrent_calls**: Valkey `t:{tid}:did:{did_id}:concurrent` INT, incremented on pick,
  decremented via `pool.Release()` called from CHANNEL_HANGUP_COMPLETE handler.

## API Summary

| Method | Path                                              | Permission         |
|--------|---------------------------------------------------|--------------------|
| GET    | /api/admin/number-pools                           | number_pool:read   |
| POST   | /api/admin/number-pools                           | number_pool:edit   |
| GET    | /api/admin/number-pools/:id                       | number_pool:read   |
| PATCH  | /api/admin/number-pools/:id                       | number_pool:edit   |
| DELETE | /api/admin/number-pools/:id                       | number_pool:edit   |
| GET    | /api/admin/number-pools/:id/dids                  | number_pool:read   |
| POST   | /api/admin/number-pools/:id/dids                  | number_pool:edit   |
| DELETE | /api/admin/number-pools/:id/dids/:didId           | number_pool:edit   |
| GET    | /api/admin/number-pools/:id/dids/:didId/stats     | number_pool:read   |
| POST   | /api/admin/number-pools/:id/dids/:didId/quarantine   | number_pool:edit |
| POST   | /api/admin/number-pools/:id/dids/:didId/unquarantine | number_pool:edit |
| GET    | /api/admin/number-pools/:id/stats                 | number_pool:read   |
