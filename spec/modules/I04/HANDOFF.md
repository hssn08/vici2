# I04 — Inbound Callback Queue: HANDOFF

Module: I04 — Inbound Callback Queue ("press 1 to receive a callback")
Branch: feat/I04-implement-*
Implementation date: 2026-05-13

---

## Summary

I04 lets inbound callers opt out of holding and receive a callback when an agent becomes free.
Two capture paths (A: I01 queue offer; B: I02 IVR terminal_callback) write to the shared D06
`callbacks` table under a new `source=INBOUND` discriminator. The I01 Go dispatcher was extended
to detect an empty live-call queue, pick a speculative agent, and fire the oldest eligible
INBOUND callback with a Valkey NX lock for idempotency. Phase 1 ships the full plumbing with a
TCPA stub (always ALLOW); C01 wires real gate enforcement in a later sprint.

---

## Migration

File: `api/prisma/migrations/20260513270000_i04_inbound_callback/migration.sql`

### Callbacks table additions
- `source ENUM('AGENT','GLOBAL','INBOUND') NOT NULL DEFAULT 'AGENT'` — discriminator (AC18)
- `original_ingroup_id VARCHAR(50) NULL` — inbound queue name at time of offer
- `original_wait_seconds SMALLINT UNSIGNED NULL` — estimated hold time shown to caller
- `callback_number VARCHAR(20) NULL` — DTMF-override number (falls back to ANI)
- `fired_at DATETIME(6) NULL` — timestamp when dispatcher promoted to LIVE
- FK: `original_ingroup_id → ingroups(id)` (ON DELETE SET NULL)
- Index: `idx_callbacks_t_ingroup_source_status (tenant_id, original_ingroup_id, source, status, callback_at)`

### Ingroups table additions (7 columns)
- `inbound_callback_enabled TINYINT(1) NOT NULL DEFAULT 0`
- `callback_number_mode ENUM('ani','dtmf_optional','dtmf_required') NOT NULL DEFAULT 'ani'`
- `max_wait_before_offer_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 120`
- `callback_expires_hours TINYINT UNSIGNED NOT NULL DEFAULT 24`
- `no_answer_policy_inbound ENUM('leave_callbk','reschedule_30m','reschedule_24h','terminate_NA') NOT NULL DEFAULT 'leave_callbk'`
- `callback_position_expiry_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60`
- `outbound_cli VARCHAR(20) NULL`

---

## New RBAC Verbs

File: `shared/types/src/rbac.ts`

| Verb | super_admin | admin | supervisor |
|------|------------|-------|------------|
| `callback:view_inbound_queue` | tenant | tenant | group |

---

## New Audit Actions

File: `api/src/auth/audit.ts`

- `callback.inbound_accepted` — Path A or B accepted the callback request
- `callback.inbound_fired` — Dispatcher promoted callback to LIVE, originate sent
- `callback.inbound_deferred` — TCPA SKIP_UNTIL: callback_at advanced to next window
- `callback.inbound_dead` — Callback expired or terminal no-answer
- `callback.inbound_no_answer` — No-answer policy applied (reschedule or terminate)

---

## Files Changed

### New files
| File | Purpose |
|------|---------|
| `api/prisma/migrations/20260513270000_i04_inbound_callback/migration.sql` | DB migration |
| `api/src/inbound-callbacks/schemas.ts` | normalizePhone, Zod schemas, ExitCallbackInboundQuery |
| `api/src/inbound-callbacks/metrics.ts` | 12 Prometheus counters/histograms (vici2_i04_* prefix) |
| `api/src/inbound-callbacks/consent.ts` | buildConsentAuditRecord() for originate_audit |
| `api/src/inbound-callbacks/service.ts` | createStubLead, createInboundCallback, deferCallback, onNoAnswerInbound, fetchQueueForIngroup |
| `api/src/routes/inbound-callbacks.ts` | GET /api/inbound-callbacks/queue/:ingroupId |
| `dialer/internal/queue/inbound_callback.go` | tryFireInboundCallback, fireInboundCallback, promoteInboundCallback, deferInboundCallback |
| `dialer/internal/queue/inbound_callback_test.go` | 9 Go unit tests |
| `api/test/inbound-callbacks/schemas.test.ts` | 14 TS tests for normalizePhone and mask |
| `api/test/inbound-callbacks/consent.test.ts` | 8 TS tests for buildConsentAuditRecord |
| `spec/modules/I04/HANDOFF.md` | This file |

### Modified files
| File | Change |
|------|--------|
| `api/prisma/schema.prisma` | New enums (CallbackSource, CallbackNumberMode, CallbackNoAnswerPolicyInbound); extended Callback and Ingroup models |
| `shared/types/src/rbac.ts` | Added callback:view_inbound_queue to VERBS + grants matrix |
| `api/src/auth/audit.ts` | 5 new audit action literals |
| `api/src/routes/internal/queue.ts` | exit_callback extended: source=inbound runs I04 path (normalise ANI, stub lead lookup, createInboundCallback, event publish) |
| `api/src/routes/internal/ivr-hooks.ts` | callback_accept/:uuid replaced raw SQL stub with full I04 createInboundCallback call |
| `api/src/server.ts` | Imports + registers registerInboundCallbackRoutes |
| `workers/src/jobs/callback-fire/tick.ts` | AC18: added source filter `{ in: ["AGENT","GLOBAL"] }` — D06 worker never fires INBOUND callbacks |
| `dialer/internal/queue/types.go` | InGroup struct: OutboundCli, CallbackNoAnswerPolicyInbound, CallbackExpiresHours, CallbackPositionExpiryMinutes |
| `dialer/internal/queue/metrics.go` | Metrics struct + NewMetrics: I04 counters and histogram |
| `dialer/internal/queue/dispatcher.go` | runDispatchCycle: empty live-call queue triggers tryFireInboundCallback |

---

## Test Results

### TypeScript (pnpm --filter api run test)
- `test/inbound-callbacks/consent.test.ts` — 8/8 PASS
- `test/inbound-callbacks/schemas.test.ts` — 14/14 PASS
- Overall suite: 1020 passed (9 pre-existing failures unrelated to I04)

### Go (go test ./internal/queue/...)
All 9 I04 tests PASS:
- TestFetchNextInboundCallback_EmptyQueue
- TestTryFireInboundCallback_LiveQueueSkip
- TestTryFireInboundCallback_LockContention
- TestDeferInboundCallback_NoDB
- TestPromoteInboundCallback_NoDB
- TestNullableInt32JSON
- TestI04CallbackFireLockKey
- TestInboundCallback_DialNumberFallback
- TestInboundCallback_NeitherNumber

`go build ./...` and `go vet ./...` clean.

---

## Architecture Notes

### TCPA (Phase 1 stub)
`fireInboundCallback` in `inbound_callback.go` calls a local `tcpaCheckStub()` that always returns
`{outcome: ALLOW}`. C01 wires the real gate in a later sprint by replacing this call with the
production `tcpa.Check(...)` call and handling `SKIP_UNTIL` via `deferInboundCallback`.

### Idempotency
The dispatcher acquires a Valkey NX lock `t:{tid}:i04:cb_fire_lock:{cbID}` with 120s TTL before
any originate. The DB UPDATE uses a CAS on `status='PENDING'` so a race at lock expiry cannot
double-fire.

### AC18 Compliance
D06 tick filter `source: { in: ["AGENT","GLOBAL"] }` guarantees the outbound campaign worker
never dials an INBOUND callback. Only the I01 dispatcher consumes INBOUND rows.

### Sentinel Campaign ID
INBOUND callbacks carry `campaignId = "__INBOUND_CB__"` (not a real DB foreign key). The
`callbacks` table `campaign_id` column is a string (no FK constraint) by prior D06 design.

### Path A (Queue Offer)
I01 internal queue (Go queuerd) sends a `source=inbound` query param on the existing
`/internal/queue/exit_callback` endpoint. The extended handler in `queue.ts` branches on this
field to invoke the I04 path (normalise ANI, lookup or create stub lead, createInboundCallback).

### Path B (IVR Terminal)
I02 IVR engine sets `vici2_callback_requested=1` in the FreeSWITCH channel variables and
terminates the call. The existing `POST /internal/ivr/callback_accept/:uuid` hook in
`ivr-hooks.ts` was upgraded from a raw SQL stub to the full I04 service layer.

### Supervisor API
`GET /api/inbound-callbacks/queue/:ingroupId` returns masked callback numbers, stale count,
pending count, position_priority_active flag, and per-row tcpa_window_open (always `true` in
Phase 1). Requires `callback:view_inbound_queue` permission.

---

## Follow-ups for Later Sprints

| ID | Description |
|----|-------------|
| C01 | Wire real TCPA gate in fireInboundCallback (replace tcpaCheckStub) |
| I04-WS | Push inbound_callback_offer WebSocket events to supervisor wallboard (S04) |
| I04-DTMF | Wire IVR DTMF collection for dtmf_optional / dtmf_required callback_number_mode |
| I04-UI | Supervisor queue panel (React component) to display fetchQueueForIngroup data |
| I04-CONFIG | Admin UI for ingroup I04 settings (7 new columns) |
| I04-EXPIRE | Cron job to mark expired INBOUND callbacks DONE (callback_expires_hours) |
| I04-NOANSWER | Invoke onNoAnswerInbound from FS ESL no-answer handler |
