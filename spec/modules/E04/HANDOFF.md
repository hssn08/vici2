# E04 Picker — Implementation Handoff

Status: DONE (Phase 2). Phase 3 items deferred.

## What was shipped

- Full `dialer/internal/picker/` package (~1100 LOC production, ~1400 LOC tests)
- Two pairing models: PROGRESSIVE (pre-pair agent) and PREDICTIVE (dial-to-PARK)
- 18-row DialOutcome table with retry policy
- 16 Prometheus metrics + alert rule definitions (see PLAN §14)
- Atomic dispatch_tokens DECR via TokenBucket (E02 contract)
- Three-layer lead-claim atomicity (ZPOPMIN + fence-token + in_flight HASH)
- Hot-reload via pubsub `config_changed` events
- SweepOrphans janitor integration (called by E06 every 60s)
- F02 schema amendments: `campaigns.lead_lock_ttl_seconds` + `campaigns.call_strategy`
- Migration: `api/prisma/migrations/20260513130000_e04_picker_amendments/migration.sql`

## Test coverage

78.2% statement coverage. Remaining uncovered are:

- `Run` goroutines in `amd_handler.go`, `answer_handler.go`, `dispatch_loop.go` — blocking event-loop goroutines; require integration test with real Valkey + ESL socket
- `handleAnswer`, `handle` (AMD) — require `*esl.Client` concrete type (no interface yet)
- `supervisor.Start` — blocking pubsub `SUBSCRIBE` goroutine
- `NewMetrics` — thin wrapper calling `prometheus.DefaultRegisterer`; safe to skip in unit tests

Integration tests (10 scenarios) and bench tests (p50/p99 benchmarks) are deferred to Phase 3.

## Phase 3 deferred items

### P3-1: Additional agent-selection strategies
`callStrategy` ENUM has four values; only `longest_wait` is implemented. `random`, `fewest_calls`, and `rank` need Lua scripts in F04.

### P3-2: Voicemail-drop AMD park action
`amd_action=park` in `amd_handler.go` (`handleAMDPark`) calls a Phase3 stub. Phase 3 must connect this to the voicemail-drop orchestrator (T02 SIP re-INVITE path).

### P3-3: AMD transfer action
`amd_action=transfer` in `amd_handler.go` (`handleAMDTransfer`) is a Phase 3 stub. Requires a Phase-3 transfer target configuration.

### P3-4: ESL client interface extraction
`answer_handler.go` and `amd_handler.go` hold `*esl.Client` (concrete type). Phase 3 should extract an `ESLClient` interface so these can be unit-tested without a real FreeSWITCH socket.

### P3-5: Campaign-affinity sharding
Multiple dialer pods each run a Supervisor. Today, all pods compete for all campaigns' tokens. Phase 3 should implement a shard-assignment protocol (per PLAN §11.2) so each pod "owns" a subset of campaigns and reduces Valkey contention.

### P3-6: Weighted list pop
`claim_lead_from_hopper.v1.lua` uses simple ZPOPMIN. Phase 3 should support the `MULTI` multi-list mix (campaigns.multi_list_mix) for weighted round-robin across lists.

### P3-7: Integration test suite
`integration_test.go` with testcontainers (Valkey + MySQL + mock-T04):
- Full progressive dispatch end-to-end
- Full predictive dispatch with answer-event simulation
- Orphan sweep
- Config hot-reload under load
- Token over-decrement recovery
- Concurrent dispatch correctness (≥10 goroutines)

### P3-8: Bench tests
`bench_test.go` p50/p99 for:
- `TokenBucket.Acquire` under contention (N=100)
- `Claimer.Claim` hopper pop (N=1000 leads)
- `CampaignConfigCache.Get` (N=10,000 campaigns)
- Full progressive tick without T04 call (~200µs target)

## Key design decisions

| Decision | Rationale |
|---|---|
| Consumer-owned `Originator` interface | Avoids picker importing originate as a concrete dep; testable with `mockOriginator` |
| Redis DECR on missing key returns -1, NOT ErrNoTokens | Standard Redis behavior; ErrNoTokens reserved for transport failures only |
| `vc.Cache` (DB 1) for freq cap | Freq cap has 24h TTL; using separate logical DB avoids key collisions with State DB |
| Token leaked on 200ms dispatch deadline | PLAN §Q8: leaking is safer than cancelling T04 in-flight; TokenLeaked metric alerts on this |
| `lead_lock_ttl_seconds` separate from `lock_ttl_sec` | `lock_ttl_sec` (E01.3) = hopper-lock TTL; `lead_lock_ttl_seconds` (E04.1) = fence-token TTL |

## Integration points

| Module | Interface |
|---|---|
| E02 (token writer) | Writes `SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2`; E04 DECRs |
| E01 (hopper filler) | SUBSCRIBE `t:{tid}:broadcast:campaign:{cid}:refill_request`; fills hopper on wake |
| M02 (config writer) | Writes `t:{tid}:campaign:{cid}:config_snapshot` JSON; PUBLISH config_changed |
| T04 (compliance gate) | Called via `Originator.Originate(ctx, OriginateRequest)` interface |
| T01 (FreeSWITCH ESL) | Used by AnswerHandler/AMDHandler for UUIDTransfer/UUIDKill |
| A04 (manual dial) | Calls `Supervisor.DispatchManual(ctx, ManualDispatchRequest)` |
| E06 (janitor) | Calls `Supervisor.SweepOrphans(ctx)` every 60s |
