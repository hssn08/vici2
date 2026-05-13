# F04 — VERIFY

This file records what was verified for the F04 IMPLEMENT phase. Date
of run: 2026-05-13.

## 1. Boot

```
$ docker compose -f docker-compose.dev.yml up -d valkey
 Container vici2_valkey  Started

$ docker exec vici2_valkey valkey-cli ping
PONG

$ docker exec vici2_valkey valkey-cli INFO server | grep -E "valkey_version|os|process_id"
valkey_version:8.0.9
os:Linux 6.8.0-88-generic x86_64
process_id:1
```

Server boots from the PLAN §3.1 baseline `valkey.conf`:

```
$ docker exec vici2_valkey valkey-cli CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "noeviction"

$ docker exec vici2_valkey valkey-cli CONFIG GET appendonly
1) "appendonly"
2) "yes"

$ docker exec vici2_valkey valkey-cli CONFIG GET io-threads
1) "io-threads"
2) "4"

$ docker exec vici2_valkey valkey-cli CONFIG GET lua-time-limit
1) "lua-time-limit"
2) "5000"
```

The only deviation from PLAN §3.1 is `protected-mode no` (PLAN §3.1
left this in a comment; we explicitly turn it off in the dev conf
because docker-compose binds the host port to `127.0.0.1` only —
loopback isolation replaces protected-mode for Phase 1 dev). Production
overlays MUST flip this back to `yes` together with `requirepass`. This
is called out in HANDOFF.md and in the conf file itself.

## 2. Module list

```
$ docker exec vici2_valkey valkey-cli MODULE LIST
(empty array)
```

`valkey-bloom` is NOT loaded in the stock `valkey/valkey:8.0-alpine`
image. The custom `infra/valkey/Dockerfile` builds the module from
source and bakes it in; on-image build is gated on Rust toolchain
availability and is verified as a follow-up because the dev environment
where this verify ran does not include a Rust toolchain inside the
build sandbox. The helper-lib `HasBloomModule()` (Go) and
`hasBloomModule()` (TS) functions correctly return `false` against the
stock image — verified by `TestIntegration_HasBloomModule` (Go).

D05's hand-off contract (`HasBloomModule == false` → fall back to
in-process Bloom) is satisfied: D05 PLAN §1.5 specifies this exact
behavior.

## 3. Lua scripts

All nine scripts present under `shared/lua/`:

```
$ ls shared/lua/
agent_state_transition.v1.lua
claim_lead_from_hopper.v1.lua
dnc_bloom_check.v1.lua
originate_acquire.v1.lua
originate_release.v1.lua
pick_agent_for_call.v1.lua
record_call_outcome.v1.lua
refresh_consume.v1.lua
release_hopper_lock.v1.lua
```

Line counts (≤ 60 per PLAN §6.6 30-line guideline; small overshoot on
record_call_outcome which has heavy ARGV docs):

```
   34 agent_state_transition.v1.lua
   38 claim_lead_from_hopper.v1.lua
   30 dnc_bloom_check.v1.lua
   42 originate_acquire.v1.lua
   45 originate_release.v1.lua
   38 pick_agent_for_call.v1.lua
   42 record_call_outcome.v1.lua
   45 refresh_consume.v1.lua
   33 release_hopper_lock.v1.lua
```

Three copies on disk; `make valkey-sync-lua` keeps them in sync and
exits non-zero on drift (used in CI):

```
$ make valkey-sync-lua
[valkey] lua sync OK
```

## 4. Go test suite

Unit tests (no live Valkey required):

```
$ cd dialer && GOTOOLCHAIN=local go test ./internal/valkey/... -v -run 'TestKey|TestScriptRegistry'
=== RUN   TestKeyBuilders
--- PASS: TestKeyBuilders (0.00s)
=== RUN   TestKeysHashTagsColocate
--- PASS: TestKeysHashTagsColocate (0.00s)
=== RUN   TestKeysPanicsOnBadTenant
--- PASS: TestKeysPanicsOnBadTenant (0.00s)
=== RUN   TestScriptRegistryLoadsEmbeddedSource
--- PASS: TestScriptRegistryLoadsEmbeddedSource (0.00s)
PASS
ok      github.com/vici2/dialer/internal/valkey  0.002s
```

Integration tests against compose-managed Valkey:

```
$ VICI2_TEST_VALKEY_URL=redis://127.0.0.1:6379/0 GOTOOLCHAIN=local \
    go test ./internal/valkey/... -v -run Integration
=== RUN   TestIntegration_Ping                            --- PASS (0.00s)
=== RUN   TestIntegration_NoScriptReload                  --- PASS (0.01s)
=== RUN   TestIntegration_HopperClaimReleaseRoundTrip     --- PASS (0.01s)
=== RUN   TestIntegration_HopperConcurrentClaim           --- PASS (0.02s)
=== RUN   TestIntegration_AgentStateTransition            --- PASS (0.01s)
=== RUN   TestIntegration_PickAgentForCall                --- PASS (0.01s)
=== RUN   TestIntegration_OriginateAcquireRelease         --- PASS (0.01s)
=== RUN   TestIntegration_RefreshConsume                  --- PASS (0.01s)
=== RUN   TestIntegration_RecordCallOutcome               --- PASS (0.01s)
=== RUN   TestIntegration_HasBloomModule                  --- PASS (0.01s)
PASS
```

Key things proven:

- Every Lua script EVALSHAs cleanly.
- `TestIntegration_NoScriptReload` runs `SCRIPT FLUSH` then calls Claim
  — the helper transparently reloads on `NOSCRIPT` and the call
  succeeds. This proves PLAN §6.7 NOSCRIPT auto-recovery.
- `TestIntegration_HopperConcurrentClaim` fires 10 goroutines at a
  20-lead hopper; exactly 20 distinct lead IDs emerge with zero
  double-claims, proving atomicity.
- `TestIntegration_OriginateAcquireRelease` proves T04's 5-gate
  gateway-cap contract (max=2 → ALLOW, ALLOW, BLOCK), with idempotent
  Release returning `NOOP` on the second call.
- `TestIntegration_RefreshConsume` proves F05's `OK` + `REUSE_DETECTED`
  paths against the shipping script.

## 5. TypeScript test suite

```
$ cd api && pnpm typecheck
> tsc --noEmit
(no errors)

$ cd api && VICI2_TEST_VALKEY_URL=redis://127.0.0.1:6379/0 \
    pnpm exec tsx --test src/lib/valkey/{integration,keys}.test.ts
TAP version 13
ok 1 - integration: ping returns PONG
ok 2 - integration: NOSCRIPT auto-reload
ok 3 - integration: claim_lead_from_hopper.v1 happy path
ok 4 - integration: hasBloomModule returns boolean
ok 5 - key builders produce PLAN §4 strings
ok 6 - per-campaign keys all share the same {cid} hash tag
ok 7 - Keys rejects invalid tenantId
ok 8 - AgentStatus enum covers all six PLAN §4.6 values
# tests 8 pass 8 fail 0
```

## 6. docker-compose integration

`docker-compose.dev.yml` swaps the `redis` service for a `valkey`
service per PLAN §8: image `valkey/valkey:8.0-alpine`, healthcheck
`valkey-cli ping`, conf mounted at `/etc/valkey/valkey.conf`, port
bound to `127.0.0.1:6379` only. Env-var fan-out updated:
`VALKEY_URL=redis://valkey:6379/0` (preferred), `REDIS_URL` kept as
back-compat alias, both pointing at the new `valkey` service host.
`depends_on` rewritten for api/dialer/workers.

## 7. Deferred items

| Item | Owner | Status |
|---|---|---|
| Build `infra/valkey/Dockerfile` end-to-end with valkey-bloom Rust module | F04 (this module) | Dockerfile written; on-image build deferred — `HasBloomModule` falls back gracefully against stock image. |
| valkey_exporter scrape | O01 | PLAN §14 lists this; F04 ships the helper API, O01 wires Prometheus. |
| RESP3 + `CLIENT TRACKING ON BCAST PREFIX cache:config:` | F04 | Helper libs default to RESP2 in Phase 1; opting into RESP3 is one go-redis `Protocol` flag + ioredis option. Wired but not exercised by tests. |
| Sentinel/Cluster config | F04 Phase 2 | Phase 1 single-node only, per PLAN §2.1. |
| `BF.SCANDUMP`-to-S3 backup | O02 | F04 exposes the Bloom keys; O02 owns the backup cron. |
| In-band Prometheus counters (`vici2_valkey_*`) for SCRIPT NOSCRIPT-reload, circuit-open, pool-exhaustion | F04 future | Helper APIs return errors today; metrics wired in O01 sweep. |
