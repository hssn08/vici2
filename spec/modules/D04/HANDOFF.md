# D04 — Status & Disposition — HANDOFF

**Module:** D04  
**Status:** DONE  
**Date:** 2026-05-13  
**Branch:** worktree-agent-a97c720fe66fb26fd  

---

## What was built

D04 implements the canonical 35-status taxonomy, 3-layer override resolution, hangup-cause mapping, disposition service, and related REST endpoints.

---

## Files created

### Migration
- `api/prisma/migrations/20260513130000_d04_status_extension/migration.sql` — widens `status VARCHAR(8)→VARCHAR(24)`, adds `recycle_delay_seconds INT NULL`, `category VARCHAR(20) NULL`, `system_owner VARCHAR(8) NULL`, CHECK constraint
- `api/prisma/migrations/20260513130000_d04_status_extension/down.sql` — rollback

### Schema
- `api/prisma/schema.prisma` — Status model updated with 3 new fields + VARCHAR(24)

### Seed data
- `db/seeds/system-statuses.json` — 35 canonical rows
- `db/seeds/hangup-cause-map.json` — 28-entry hangup_cause → status map

### Source
- `api/src/statuses/service.ts` — StatusService (list, resolve, isSelectable, hotkeyMap, validateTransition, resolveFromHangup, upsert, create, delete)
- `api/src/statuses/disposition-service.ts` — DispositionService.submit() with transaction + side-effects
- `api/src/statuses/hangup-map.ts` — resolveFromHangupCause() pure function + hot-reload
- `api/src/statuses/cache.ts` — in-process LRU (60s TTL) + Valkey pubsub invalidation
- `api/src/statuses/events.ts` — lead.status_changed event publisher
- `api/src/statuses/metrics.ts` — 9 Prometheus counters/histograms
- `api/src/statuses/validators.ts` — Zod schemas (StatusCodeSchema, HotkeySchema, RecycleDelaySchema, CategorySchema)
- `api/src/statuses/index.ts` — Fastify route registration
- `api/src/statuses/handlers/` — 8 handler files (list-system, list-campaign, create, update, delete, hangup-map, reload, bulk-reset)

### Shared types
- `shared/types/src/status.ts` — EffectiveStatus, StatusDef, TransitionResult interfaces
- `shared/types/src/index.ts` — re-exports status.ts

### Tests
- `api/test/statuses/service.test.ts` — 19 tests (list, resolve, hotkeyMap, 7 illegal transitions)
- `api/test/statuses/three-layer-merge.test.ts` — 11 fixture cases
- `api/test/statuses/disposition-service.test.ts` — 6 tests (side-effects, DNC, events)
- `api/test/statuses/hangup-map.test.ts` — 30 tests (all 28 entries + unknown fallback)
- `api/test/statuses/cache.test.ts` — 7 tests (LRU TTL, invalidation, pubsub)
- `api/test/statuses/validators.test.ts` — validator schema tests

### CI
- `scripts/ci/check-status-seed.sh` — 6 assertions on system-statuses.json
- `scripts/ci/check-drop-rate-denominator.sh` — guards M08 drop-rate denominator

---

## REST API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/admin/system-statuses` | `campaign:read` | All 35 __SYS__ rows |
| GET | `/api/admin/campaigns/:cid/statuses` | `campaign:read` | 3-layer merged; used by A06 picker |
| POST | `/api/admin/campaigns/:cid/statuses` | `campaign:edit` | Per-campaign custom status |
| PATCH | `/api/admin/campaigns/:cid/statuses/:code` | `campaign:edit` | `__SYS__` cid → 403 |
| DELETE | `/api/admin/campaigns/:cid/statuses/:code` | `campaign:edit` | Shadow rows only |
| GET | `/api/admin/hangup-cause-map` | `audit:view` | Raw map for admin |
| POST | `/api/admin/d04/reload` | `tenant:edit` | Hot-reload map |
| POST | `/api/admin/leads/bulk-reset` | `tenant:edit` | M07 list reset |

---

## TypeScript interface for consumers

```typescript
// From api/src/statuses/service.ts
class StatusService {
  list(tenantId: bigint, campaignId: string): Promise<EffectiveStatus[]>
  resolve(tenantId: bigint, campaignId: string, code: string): Promise<EffectiveStatus | null>
  isSelectable(tenantId: bigint, campaignId: string, code: string): Promise<boolean>
  hotkeyMap(tenantId: bigint, campaignId: string): Promise<Record<string, string>>
  validateTransition(tenantId: bigint, from: string, to: string): Promise<TransitionResult>
  resolveFromHangup(tenantId: bigint, campaignId: string, hangupCause: string): Promise<string>
  upsert(redis, tenantId, campaignId, code, def): Promise<EffectiveStatus>
  create(redis, tenantId, campaignId, code, def): Promise<EffectiveStatus>
  delete(redis, tenantId, campaignId, code): Promise<boolean>
}
```

---

## Consumer-specific guidance

### A06 (agent disposition picker)
- Call `GET /api/admin/campaigns/:cid/statuses` at picker init
- Filter by `selectable=true` for the agent UI
- Use `hotkeyMap()` for keyboard shortcuts
- Submit via `dispositionService.submit()` with `statusCode`, `leadId`, `callUuid`, `previousStatus`

### E01 (hopper filler)
- Status `recycleDelaySeconds` drives re-queue scheduling
  - `-1` = terminal, do not re-queue
  - `0` = immediate
  - `null` = use `campaigns.recycle_delay_seconds`
  - `>0` = seconds
- E01 owns `campaigns.dial_statuses` (which codes are re-dialed); D04 owns the delay values
- `EXCEEDED_CALL_CAP` is set by E01 when `called_count >= max_calls_per_lead`

### T04 (originate / hangup resolution)
- Call `resolveFromHangup(tenantId, campaignId, hangupCause)` after `CHANNEL_HANGUP`
- Pre-bridge: use hangup-cause map
- Post-bridge (agent already disposed): agent dispo wins, do not call D04
- T04 typed errors map to:
  - `ErrTCPABlocked` → `TCPA` (recycleDelaySeconds=null, E01 uses C01 NextOpen)
  - `ErrConsentBlocked` → `CONSENT_NOT_OBTAINED` (terminal)
  - `ErrGatewayLimit` → `GATEWAY_LIMIT_TRY_LATER` (recycleDelaySeconds=0)
  - `ErrCarrierFail` → `CARRIER_FAIL` (recycleDelaySeconds=0)

### E05 (drop-rate gate)
- `humanAnswered=true` is the FCC 3% drop-rate denominator
- `DROP` status: `humanAnswered=true`, `recycleDelaySeconds=300`
- `PDROP` status: `humanAnswered=true`, `recycleDelaySeconds=-1`
- Use `StatusService.resolve()` to check `humanAnswered` flag per call

### M07 (list reset)
- Call `POST /api/admin/leads/bulk-reset` with `tenant:edit` permission
- Body: `{ campaignId, listIds?, fromStatuses?, toStatus?, reason? }`
- Response: `{ affectedCount, toStatus, campaignId, resetAt }`

### M08 (reporting)
- **CRITICAL**: Use `SUM(s.human_answered)` as the FCC drop-rate denominator (never `COUNT(*)`)
- Use `category` column for AMD rate (`category='system-amd'`) and carrier-fail rate
- Canonical SQL in D04 PLAN §8.2 — pinned by `check-drop-rate-denominator.sh` CI

### D05 (DNC service)
- D04 calls `dncService.addInternal()` non-blocking after disposition with `dnc=true`
- Caller: `{ tenantId, phoneE164, source:'internal', campaignId:'__GLOBAL__', addedBy: userId }`
- Failure is logged; D05 eventual-consistency worker reconciles

### D06 (callbacks)
- `CALLBK` status: `callback=true`, `recycleDelaySeconds=null` (scheduling owned by D06)
- `CBHOLD` status: lifecycle state (terminal-ish, D06 triggers transition to QUEUE)
- Callback subgraph: `CALLBK → CBHOLD → QUEUE → INCALL → <dispo>`

---

## Recycle-delay semantics (quick reference)

| Value | Meaning |
|---|---|
| `-1` | Terminal — never re-dial without force-recycle (M03/D06) |
| `0` | Immediate re-queue on sibling gateway (CARRIER_FAIL, GATEWAY_LIMIT_TRY_LATER) |
| `null` | Use `campaigns.recycle_delay_seconds` as floor |
| `>0` | Seconds before E01 re-queues the lead |

---

## 7 illegal transitions (enforced at service layer)

| From | To | Error code |
|---|---|---|
| Any | `INCALL` | `illegal_to_incall` |
| Any | `QUEUE` | `illegal_to_queue` |
| Any | `NEW` | `illegal_to_new` |
| `SALE` | Any | `sale_immutable` |
| Any | `INVALID` | `illegal_to_invalid` |
| `DNC` | Any | `dnc_immutable` |
| Any terminal (`recycleDelaySeconds=-1`) | Any | `terminal_status` |

---

## Prometheus metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `vici2_d04_disposition_writes_total` | Counter | `status`, `outcome` |
| `vici2_d04_hangup_resolutions_total` | Counter | `cause`, `status` |
| `vici2_d04_hangup_unmapped_total` | Counter | `cause` |
| `vici2_d04_cache_ops_total` | Counter | `op` (hit/miss/invalidate) |
| `vici2_d04_dnc_side_effect_total` | Counter | `outcome` |
| `vici2_d04_crm_webhook_total` | Counter | `outcome` |
| `vici2_d04_terminal_recycle_writes_total` | Counter | — |
| `vici2_d04_illegal_transition_total` | Counter | `from`, `to` |
| `vici2_d04_disposition_write_latency_ms` | Histogram | — |
