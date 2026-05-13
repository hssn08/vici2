# F04 — HANDOFF

This file is the public surface F04 hands to downstream modules. The
PLAN's §11 hand-off table is the contract; this is the as-shipped
realization.

## 1. What landed

- `infra/valkey/valkey.conf` — Phase 1 baseline, per PLAN §3.1. Dev
  copy has `protected-mode no` (loopback isolation via compose port
  binding); production overlays MUST flip to `yes` + `requirepass`.
- `infra/valkey/Dockerfile` — two-stage build that bakes
  `valkey-bloom` into the image. Stock `valkey/valkey:8.0-alpine`
  also works; helper libs detect the module absence and fall back.
- `infra/valkey/lua/README.md` — index pointing to `shared/lua/`.
- `shared/lua/*.v1.lua` — nine canonical scripts (single source of
  truth; copies under `dialer/internal/valkey/lua/` and
  `api/src/lib/valkey/lua/` are auto-synced via `make valkey-sync-lua`).
- `dialer/internal/valkey/` — Go helper library
  (`client.go`, `keys.go`, `scripts.go`, `hopper.go`, `agent.go`,
  `originate.go`, `keys_test.go`, `integration_test.go`).
- `api/src/lib/valkey/` — TypeScript helper library
  (`client.ts`, `keys.ts`, `scripts.ts`, `index.ts`,
  `keys.test.ts`, `integration.test.ts`).
- `docker-compose.dev.yml` — `redis` service replaced with `valkey`,
  env-vars + depends_on rewritten.
- `Makefile` — `valkey-cli`, `valkey-sync-lua` targets; `redis-cli`
  retained as alias.

## 2. Lua script registry (FROZEN)

| ScriptName (Go const / TS literal) | File | KEYS | ARGV |
|---|---|---|---|
| `ScriptClaimLeadFromHopper` / `claim_lead_from_hopper.v1` | claim_lead_from_hopper.v1.lua | 3 (hopper ZSET, lead_lock prefix, in_flight HASH) | 3 (TTL sec, instance_id, now_ms) |
| `ScriptReleaseHopperLock` / `release_hopper_lock.v1` | release_hopper_lock.v1.lua | 3 (lock key, in_flight HASH, hopper ZSET) | 4 (lead_id, reinsert "0"/"1", score, expected lock value) |
| `ScriptRecordCallOutcome` / `record_call_outcome.v1` | record_call_outcome.v1.lua | 6 (drop_window, events stream, in_flight HASH, call HASH, call:active SET, campaign:{cid}:active_calls SET) | 9 (answered, dropped, ts_ms, call_uuid, lead_id, campaign_id, tenant_id, dw MAXLEN, events MAXLEN) |
| `ScriptPickAgentForCall` / `pick_agent_for_call.v1` | pick_agent_for_call.v1.lua | 5 (per-camp READY ZSET, global READY ZSET, per-camp RESERVED ZSET, global RESERVED ZSET, agent HASH prefix) | 2 (call_uuid, ts_ms) |
| `ScriptAgentStateTransition` / `agent_state_transition.v1` | agent_state_transition.v1.lua | 5 (agent HASH, old global ZSET, old per-camp ZSET, new global ZSET, new per-camp ZSET) | 4+ (user_id, expected_status, new_status, ts_ms, optional HSET pairs) |
| `ScriptOriginateAcquire` / `originate_acquire.v1` | originate_acquire.v1.lua | 2 (gw counter, in_flight HASH per call_uuid) | 7 (max_concurrent, call_uuid, lead_id, campaign_id, gateway_id, ts_ms, in_flight TTL sec) |
| `ScriptOriginateRelease` / `originate_release.v1` | originate_release.v1.lua | 2 (gw counter, in_flight HASH per call_uuid) | 1 (call_uuid) |
| `ScriptDNCBloomCheck` / `dnc_bloom_check.v1` | dnc_bloom_check.v1.lua | N (Bloom keys, one per source) | 1 (phone E.164) |
| `ScriptRefreshConsume` / `refresh_consume.v1` | refresh_consume.v1.lua | 3 (token HASH, family SET, user SET — KEYS[3] may be "") | 1 (family_id) |

Versioning rule (PLAN §6.6): any change is a new file `*.v2.lua`. The
helper API names embed the version (`*_v1`). Two versions can coexist
in flight; the helper library SCRIPT LOADs the registered set at boot.

## 3. Go API surface

Imports: `github.com/vici2/dialer/internal/valkey`

```go
// Construction (env-driven; preferred for app code).
c, err := valkey.NewFromEnv(ctx)

// Or with an explicit config.
c, err := valkey.New(ctx, valkey.Config{
    URL: "redis://valkey:6379/0",
    TenantID: 1,
})
defer c.Close()

// Health.
if err := c.Ping(ctx); err != nil { ... }
hasBloom, _ := c.HasBloomModule(ctx)

// Typed keys.
hopperKey := c.Keys.CampaignHopper(42)
agentKey  := c.Keys.Agent(7)

// Hopper ops.
c.Hopper().Push(ctx, cid, leadID, score)
leadID, lockVal, err := c.Hopper().Claim(ctx, cid, "instance-A", 30, time.Now().UnixMilli())
released, err := c.Hopper().Release(ctx, cid, leadID, lockVal, false /* reinsert */, 0)

// Agent ops.
ok, err := c.Agents().Transition(ctx, cid, userID, valkey.AgentReady, valkey.AgentInCall, nowMs)
uid, err := c.Agents().PickForCall(ctx, cid, callUUID, nowMs)

// Originate (T04 5-gate atomic).
ar, err := c.Originate().Acquire(ctx, gwID, cid, leadID, callUUID, maxConcurrent, nowMs, 60)
released, after, err := c.Originate().Release(ctx, gwID, callUUID)

// Raw Lua dispatch (for D05 BF.EXISTS pipeline, F05 refresh-token, etc.).
res, err := c.Scripts.Eval(ctx, c.State, valkey.ScriptDNCBloomCheck,
    []string{valkey.DNCFederalBloom(), c.Keys.DNCInternalBloom()}, "+14155551212")
```

`c.State` and `c.Cache` expose the underlying `*redis.Client` for cases
the typed surface doesn't cover (XADD, XREADGROUP, PUBLISH, SUBSCRIBE).

## 4. TypeScript API surface

Imports: `from "../lib/valkey/index.js"` (within `api/src/`).

```ts
import { VRedisClient } from "../lib/valkey/index.js";

const c = await VRedisClient.fromEnv();
// or
const c = await VRedisClient.create({ stateUrl: "redis://valkey:6379/0", tenantId: 1 });

await c.ping();
const hasBloom = await c.hasBloomModule();

// Typed keys.
const k = c.keys;
const hopper = k.campaignHopper(42);
const agent  = k.agent(7);

// Raw Lua dispatch (F05 uses this for refresh-token rotation).
const res = await c.scripts.eval(c.state, "refresh_consume.v1",
    [tokKey, famKey, userKey], [familyId]);

// ioredis primitives.
await c.state.zadd(hopper, score, leadId);
const callId = await c.state.xadd(eventStream("call", "answered"),
    "*", "call_uuid", uuid, "tenant_id", String(tenantId));

await c.close();
```

`c.state` and `c.cache` are ioredis `Redis` instances (DB 0 + DB 1).

## 5. Env vars (consumer contract)

| Var | Default | Used by |
|---|---|---|
| `VALKEY_URL` | none | api, dialer, workers |
| `VALKEY_STATE_URL` | falls back to `VALKEY_URL` then `REDIS_URL` | same |
| `VALKEY_CACHE_URL` | falls back to `VALKEY_URL` | same |
| `VALKEY_PASSWORD` | empty (dev) | same |
| `REDIS_URL` | back-compat alias | legacy code |
| `VICI2_DEFAULT_TENANT_ID` | `1` | key builders |

In docker-compose.dev.yml all three services set
`VALKEY_URL=redis://valkey:6379/0` and `REDIS_URL=redis://valkey:6379/0`
so any code reading either works.

## 6. Downstream contracts (PLAN §11 realization)

| Module | Used surface |
|---|---|
| **T01 (ESL bridge)** | `c.State.XAdd(...)` for `events:vici2.call.*`; `c.State.Publish(...)` for `broadcast:*`. Helper `EventStream("call","answered")` builder. T01 OWNS the call HASH lifecycle (HSET on CHANNEL_CREATE, DEL on CHANNEL_HANGUP_COMPLETE). |
| **T02 (gateway accounting)** | `c.Keys.GatewayActive(gid)` STRING counter + 60s reconciler. Lua scripts `originate_acquire.v1` and `originate_release.v1` are the only writers. |
| **T04 (originate audit)** | `c.Originate().Acquire(...)` and `c.Originate().Release(...)`. Returns `ErrGatewayLimit` sentinel; the rest of the 5-gate chain (drop_cap, tcpa, dnc, consent) lives in T04. The in_flight HASH key shape `t:{tid}:in_flight:{call_uuid}` is exposed via `c.Keys.InFlightCall(uuid)`. |
| **E01 (hopper filler)** | `c.Hopper().Push(...)` / `PushBatch` (implement via pipeline on `c.State`). |
| **E02–E06 (dialer engine)** | `c.Hopper().Claim/Release(...)`, `c.Agents().PickForCall(...)`, `c.Agents().Transition(...)`. |
| **A03 (WS gateway)** | `c.state.subscribe(c.keys.broadcastAgent(uid))` etc. No-replay semantic on reconnect documented in PLAN §4.9. |
| **S01 (wallboard)** | `XREADGROUP` against `events:vici2.*` via ioredis primitives. Convention `XAUTOCLAIM` 60s. |
| **C03 (audit log)** | Same as S01; consumer-group name `audit-export`. |
| **D05 (DNC)** | `c.Scripts.Eval(ctx, c.State, valkey.ScriptDNCBloomCheck, ...)`. `c.HasBloomModule(ctx)` is the fail-mode discriminator. Bloom key builders: `c.Keys.DNCInternalBloom()`, `c.Keys.DNCStateBloom()`, `DNCFederalBloom()`, `DNCLitigatorBloom()`. |
| **F05 (refresh-token)** | `c.scripts.eval(c.state, "refresh_consume.v1", ...)`. Key builders: `keys.authRefresh(...)`, `keys.authRefreshFamily(...)`, `keys.authRefreshUser(...)`. Lockout / HIBP cache keys are caller-managed (not yet typed; F05 may add to `keys.ts` if needed). |
| **F01 (compose)** | Already adopted: `valkey` service replaced `redis`. |
| **O01 (metrics)** | F04 surfaces are error-bearing; O01 wires Prometheus counters (`vici2_*_valkey_script_eval_total`, `_circuit_open_total`, `_noscript_reload_total`). The hooks are TODO comments; PLAN §13 acceptance is on hold for O01 to land. |
| **O02 (backup)** | Nightly `BGSAVE` + S3 copy. `valkey-bloom` keys back up via `BF.SCANDUMP` (D05 PLAN §1.9). |

## 7. Open items / risks

1. **`valkey-bloom` on-image build** — the Dockerfile clones the
   upstream repo at `main`. Once a stable tag is published, pin it via
   `VALKEY_BLOOM_REF` build arg. Until the image is built into CI, dev
   runs the stock `valkey/valkey:8.0-alpine` and D05 falls back to
   in-process Bloom.
2. **`protected-mode no`** in dev — production overlays MUST flip back
   on with `requirepass`. Add a CI lint to fail if `protected-mode no`
   appears outside `infra/valkey/valkey.conf` (dev only).
3. **RESP3 + client tracking** — go-redis/ioredis support it; the wrap
   currently leaves the default (RESP2). When O01 adds cache-config
   tracking metrics, flip `Protocol: 3` in `Config.applyDefaults` and
   add `enableAutoPipelining` (ioredis already on).
4. **`HopperOps.Release` on absent lock** — current Lua semantics: if
   the lock key does not exist (i.e. `GET` returns nil), the script
   skips the comparison and returns 1 (success). This is consistent
   with "idempotent release" but a future hardening could distinguish
   "lock was already gone" from "lock matched and was deleted" by
   returning 2 vs 1.
5. **Type drift Go ↔ TS** — `AgentStatus` is duplicated in two
   languages. Phase 4 will codegen from a shared JSON Schema (PLAN
   §13.1 risk row); for now eyeball + lint.
6. **Lua source duplication** — `shared/lua/` is the source of truth;
   `make valkey-sync-lua` keeps two embedded copies. A pre-commit
   lefthook on the `shared/lua/` glob should fail when sync is stale.
   (CI lint not yet added.)

## 8. Pointers

- Lua source: `shared/lua/*.v1.lua`
- Go wrapper: `dialer/internal/valkey/`
- TS wrapper: `api/src/lib/valkey/`
- Image build: `infra/valkey/Dockerfile`
- Conf: `infra/valkey/valkey.conf`
- Tests: `dialer/internal/valkey/{keys,integration}_test.go` and
  `api/src/lib/valkey/{keys,integration}.test.ts`.
- Workflow: `make dev` boots Valkey; `make valkey-cli` opens a shell;
  `make valkey-sync-lua` syncs scripts.
