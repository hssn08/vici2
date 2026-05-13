# X05 — Local-Presence Caller-ID — PLAN

| Field | Value |
|---|---|
| **Module** | X05 — Local-Presence Caller-ID |
| **Author** | X05-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting X04 PLAN freeze |
| **Companion** | [RESEARCH.md](./RESEARCH.md) |
| **Module spec** | `spec/modules/X05.md` |
| **Depends on (FROZEN upstream)** | X04 PLAN (number_pools schema + `pickCallerId` contract); F02 PLAN (schema conventions, did_numbers model); F04 PLAN (Valkey key conventions, pipeline patterns); D03 PLAN (`resolvePhoneTz` — state lookup from NPA); T02 PLAN (did_numbers.carrier_id available) |
| **Blocks** | E04 IMPLEMENT (consumes updated `pickCallerId` signature); O01 (consumes X05 Prometheus metrics) |

This PLAN extends X04's number pool infrastructure with local-presence NPA
matching. It defines the exact Valkey key schema, the four-tier selection
algorithm, the index builder worker, the schema amendments, and the acceptance
criteria the IMPLEMENT phase must satisfy. Once approved, the following are
FROZEN: the Valkey key forms, the `pickCallerId` extended signature, the
`match_tier` Prometheus label values, the neighbor NPA embedded map, and the
`local_presence_enabled` column name. Algorithm internals (neighbor expansion
policy, health-check pipeline count cap) may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **X05 is a layer on top of X04, not a replacement.** `pickCallerId()` in
   `api/src/services/number-pool/picker.ts` grows an optional `localPresence`
   code path that runs before X04's round-robin when `pool.local_presence_enabled
   = true` and the lead has a resolved NPA. X04's health-weighted fallback is
   the mandatory last tier (Tier 4). X05 adds Tiers 1–3 above it.

2. **No new MySQL tables.** One column added to X04's `number_pools` table
   (`local_presence_enabled BOOLEAN NOT NULL DEFAULT false`). DID NPA is derived
   from `did_numbers.e164` at index-build time; no new column on `did_numbers`.
   One column proposed on `originate_audit` for analytics (`cid_match_tier
   TINYINT NULL`), filed as F02 amendment.

3. **Valkey index: two SET families per pool.** `t:{tid}:pool:{pid}:npa:{npa}`
   and `t:{tid}:pool:{pid}:state:{st}`. Both are maintained by a lightweight
   event-driven worker that subscribes to X04's pool-membership Valkey pub/sub
   channel. Cold-start bootstrap (first originate with empty index) runs an
   on-demand MySQL query and populates both families before returning.

4. **Four tiers, in order: exact NPA → neighbor NPA → same state → X04 pool
   fallback.** Each tier that fires increments `vici2_x05_match_tier_total{tier}`.
   Toll-free/reserved NPAs skip to Tier 4 immediately.

5. **SRANDMEMBER + pipeline quarantine check = ≤1ms per tier.** Each tier
   performs one SRANDMEMBER, then pipelines N EXISTS calls (quarantine keys) for
   the returned candidate(s). Max candidates checked per tier = 5 (configurable).
   Worst-case pipeline (all 4 tiers, 5 candidates each) = ~2ms. Budget is ≤5ms.

6. **Neighbor NPA table is embedded in the Go dialer binary as a static map.**
   It covers the 30 highest-volume US metro overlay zones as of 2026. Updated
   via a redeployment. Phase-2 moves to an admin-editable Valkey hash for hot
   updates.

7. **`local_presence_enabled` flag gates the feature per pool.** When false,
   `pickCallerId` routes directly to X04's existing logic — zero overhead on
   pools that do not use local presence. When true, the NPA tiers are checked
   first.

8. **Index builder is a lightweight goroutine in the dialer, not a new service.**
   It subscribes to `t:{tid}:pool-membership:events` (X04 pub/sub channel) and
   runs `SADD` / `SREM` on the NPA and state SETs. On startup, it queries MySQL
   for all pools with `local_presence_enabled=true` and rebuilds their indexes
   if `npa_index_built` is absent or expired.

9. **STIR/SHAKEN A-attestation note (deferred).** Phase-1 uses any tenant-owned
   DID with a matching NPA. Phase-2 will add carrier-match preference to maximize
   A-attestation. The picker signature includes an optional `gatewayCarrierId`
   param (ignored in Phase 1) so the Phase-2 upgrade is backward-compatible.

10. **LOC estimate: ~480 lines**, of which ~200 are shared types and Valkey
    pipeline helpers already written for X04. Net new X05-specific code: ~280
    lines plus ~100 lines of tests.

---

## 1. Goals and Non-Goals

### 1.1 Goals

- Match called party's NPA with a same-area-code DID from the assigned pool.
- Four-tier fallback: exact NPA → neighbor NPA → same state → X04 pool fallback.
- Valkey-backed NPA index with ≤5ms lookup latency end-to-end.
- Index kept current via event-driven worker; cold-start bootstrap handles
  empty index.
- Per-match-tier Prometheus counter.
- `local_presence_enabled` flag per pool; no overhead when disabled.
- No new MySQL tables; extends X04 schema only.
- Admin-visible per-NPA coverage report (deferred to M07/M08 but data exposed).

### 1.2 Non-Goals

- International (non-NANP) local presence — deferred.
- Carrier-aware A-attestation preference — Phase 2.
- Per-NPA health weighting (ZSET) — Phase 2 (Phase 1 uses SRANDMEMBER).
- Admin UI to edit neighbor NPA table at runtime — deferred to M08.
- CNAM (caller name) matching — separate feature, not in scope.

---

## 2. Schema Amendments (extends X04, no new tables)

### 2.1 `number_pools` table — X04 Amendment X05.1

```sql
ALTER TABLE number_pools
  ADD COLUMN local_presence_enabled TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'X05: when true, prefer same-NPA DID before pool round-robin';
```

Prisma model amendment (to `api/prisma/schema.prisma`, under the X04 block):

```prisma
// X05.1
localPresenceEnabled  Boolean @default(false) @map("local_presence_enabled")
```

### 2.2 `originate_audit` table — F02 Amendment F02.X05.1

```sql
ALTER TABLE originate_audit
  ADD COLUMN cid_match_tier TINYINT UNSIGNED NULL
    COMMENT 'X05: 1=exact_npa 2=neighbor_npa 3=same_state 4=pool_fallback NULL=local_presence_disabled';
```

This is additive and backward-compatible. Rows originating before X05 have
`cid_match_tier = NULL`, which is correct.

### 2.3 Migration file

```
api/prisma/migrations/20260513260000_x05_local_presence/migration.sql
```

Contents: the two ALTER TABLE statements above. Prisma migration name follows
repo convention: `YYYYMMDDHHMMSS_<module_id>_<slug>`.

### 2.4 No other schema changes

DID NPA is derived at runtime from `did_numbers.e164`: NPA = `e164.slice(2, 5)`
(NANP E.164 format `+1NPA-NXX-XXXX`). No new column on `did_numbers`.
State mapping uses the existing `phone_codes` table via D03's in-process cache.

---

## 3. Valkey Key Schema

All keys follow the vici2 convention `t:{tid}:...` (F04 PLAN §4.1).

### 3.1 NPA Index SET

```
Key:    t:{tid}:pool:{pool_id}:npa:{npa}
Type:   SET
Value:  set of DID IDs as decimal strings
TTL:    none (persistent; updated on pool membership events)
Owner:  X05 index builder writes; X05 picker reads
```

Example:
```
t:1:pool:7:npa:415  →  {"1001", "1002", "1017"}
t:1:pool:7:npa:650  →  {"1003"}
```

### 3.2 State Index SET

```
Key:    t:{tid}:pool:{pool_id}:state:{state}
Type:   SET
Value:  set of DID IDs as decimal strings
TTL:    none (persistent; updated on pool membership events)
Owner:  X05 index builder writes; X05 picker reads
```

Example:
```
t:1:pool:7:state:CA  →  {"1001", "1002", "1003", "1017"}
```

### 3.3 Index Built Sentinel

```
Key:    t:{tid}:pool:{pool_id}:npa_index_built
Type:   STRING  ("1")
TTL:    86400 (24 hours)
Owner:  X05 index builder sets after full rebuild
```

On expiry, the next picker call that misses on Tier 1 triggers a background
rebuild if the pool has `local_presence_enabled=true`.

### 3.4 Pool Membership Event Channel (X04 owns, X05 subscribes)

```
Channel:  t:{tid}:pool-membership:events
Message format (JSON):
  { "event": "did_added" | "did_removed",
    "pool_id": 7,
    "did_id": 1017,
    "did_e164": "+14155551234",
    "tenant_id": 1 }
```

X04's pool service publishes to this channel when a DID is added to or removed
from a pool. X05's index builder subscribes and updates NPA/state SETs accordingly.

### 3.5 Key Deletion on Pool Deletion

When a pool is deleted (X04), all `t:{tid}:pool:{pool_id}:npa:*` and
`t:{tid}:pool:{pool_id}:state:*` keys must be deleted. X04's pool deletion
handler runs a Valkey SCAN+DEL for the pool prefix. X05 adds the NPA and state
prefixes to the deletion list.

---

## 4. Selection Algorithm — `pickCallerIdWithLocalPresence()`

### 4.1 Location in Codebase

The existing X04 picker lives at:
```
api/src/services/number-pool/picker.ts   (TypeScript, called by API/worker)
dialer/internal/originate/pickCaller.go  (Go, called on hot originate path)
```

X05 extends the **Go dialer path** because origination is in the dialer process
(E04 → T04 → pickCaller). The TypeScript path is for admin preview and testing.

### 4.2 Go Function Signature

```go
// package originate

// PickResult is returned by the X05-extended picker.
type PickResult struct {
    DIDE164    string    // selected DID in E.164 format
    DidID      int64     // database PK
    MatchTier  int       // 1-4; see constants
    MatchNPA   string    // the NPA that matched (tiers 1-3); empty for tier 4
}

const (
    MatchTierExactNPA    = 1
    MatchTierNeighborNPA = 2
    MatchTierSameState   = 3
    MatchTierPoolFallback = 4
)

// PickCallerID selects a caller-ID DID for an outbound originate.
// pool must have LocalPresenceEnabled=true for tiers 1-3 to be attempted.
// gatewayCarrierId is reserved for Phase-2 A-attestation preference (pass 0).
func (p *Picker) PickCallerID(
    ctx context.Context,
    tenantID int64,
    poolID int64,
    calledE164 string,
    gatewayCarrierId int64, // Phase-2: 0 = ignore
) (PickResult, error)
```

### 4.3 Algorithm Pseudocode

```go
func (p *Picker) PickCallerID(ctx, tenantID, poolID, calledE164, gwCarrierID) {
    pool := p.poolCache.Get(poolID)  // cached from MySQL; refreshed every 60s

    if !pool.LocalPresenceEnabled {
        // Fast path: skip local presence entirely
        return p.x04Fallback(ctx, tenantID, poolID)
    }

    calledNPA := extractNPA(calledE164)  // e164[2:5]; validates NANP format
    if isReservedNPA(calledNPA) {
        // Toll-free, 900, 555, etc. — skip to tier 4
        p.metrics.matchTier.With(tier4Label).Inc()
        return p.x04Fallback(ctx, tenantID, poolID)
    }

    // Tier 1: exact NPA match
    didID, ok := p.sampleHealthyDID(ctx, tenantID, poolID, npaKey(tenantID, poolID, calledNPA))
    if ok {
        return PickResult{..., MatchTier: 1, MatchNPA: calledNPA}, nil
    }

    // Tier 2: neighbor NPA match
    for _, neighborNPA := range neighborNPAs(calledNPA) {
        didID, ok = p.sampleHealthyDID(ctx, tenantID, poolID, npaKey(tenantID, poolID, neighborNPA))
        if ok {
            return PickResult{..., MatchTier: 2, MatchNPA: neighborNPA}, nil
        }
    }

    // Tier 3: same state match
    calledState := p.tzResolver.StateForNPA(calledNPA)  // D03 in-process cache
    if calledState != "" {
        didID, ok = p.sampleHealthyDID(ctx, tenantID, poolID, stateKey(tenantID, poolID, calledState))
        if ok {
            return PickResult{..., MatchTier: 3, MatchNPA: ""}, nil
        }
    }

    // Tier 4: X04 pool fallback
    p.metrics.matchTier.With(tier4Label).Inc()
    return p.x04Fallback(ctx, tenantID, poolID)
}

func (p *Picker) sampleHealthyDID(ctx, tenantID, poolID, valKeyKey) (int64, bool) {
    // SRANDMEMBER with count=-5 returns up to 5 unique candidates
    candidates := p.valkey.SRandMemberN(ctx, valKeyKey, -5)
    if len(candidates) == 0 {
        // Trigger async index build if sentinel missing
        if !p.indexSentinelExists(ctx, tenantID, poolID) {
            go p.indexBuilder.RebuildPool(context.Background(), tenantID, poolID)
        }
        return 0, false
    }
    // Pipeline: N EXISTS quarantine checks
    quarantineKeys := make([]string, len(candidates))
    for i, cid := range candidates {
        quarantineKeys[i] = quarantineKey(tenantID, poolID, cid)
    }
    exists := p.valkey.PipelineExists(ctx, quarantineKeys)
    for i, isQuarantined := range exists {
        if !isQuarantined {
            return candidates[i], true
        }
    }
    return 0, false  // all candidates quarantined
}
```

### 4.4 Toll-Free / Reserved NPA Detection

```go
var reservedNPAs = map[string]bool{
    "800": true, "833": true, "844": true, "855": true,
    "866": true, "877": true, "888": true, // toll-free
    "900": true,                           // premium-rate
    "555": true,                           // fictitious
    "976": true,                           // pay-per-call
    "500": true, "521": true, "522": true, // PCS
    "524": true, "533": true, "544": true,
    "566": true, "577": true, "588": true,
}

func isReservedNPA(npa string) bool { return reservedNPAs[npa] }
```

### 4.5 Neighbor NPA Table (embedded map, phase-1)

```go
// neighborNPAs returns overlay and geographically adjacent NPAs for the given NPA.
// Source: NANPA overlay assignments as of 2026-Q1.
var npaNeighbors = map[string][]string{
    // New York City
    "212": {"646", "332"},
    "646": {"212", "332"},
    "332": {"212", "646"},
    "718": {"347", "929"},
    "347": {"718", "929"},
    "929": {"718", "347"},
    // Los Angeles basin
    "213": {"323", "747"},
    "310": {"424"},
    "323": {"213", "747"},
    "424": {"310"},
    "747": {"818", "213"},
    "818": {"747", "626"},
    "626": {"818"},
    "562": {"657"},
    "657": {"562"},
    // Atlanta
    "404": {"678", "470"},
    "678": {"404", "470"},
    "470": {"404", "678"},
    // Chicago
    "312": {"872"},
    "773": {"872"},
    "872": {"312", "773"},
    // Houston
    "713": {"832", "281", "346"},
    "832": {"713", "281", "346"},
    "281": {"713", "832", "346"},
    "346": {"713", "832", "281"},
    // Dallas / Fort Worth
    "214": {"469", "972", "945"},
    "469": {"214", "972", "945"},
    "972": {"214", "469", "945"},
    "945": {"214", "469", "972"},
    // San Francisco Bay Area
    "415": {"628"},
    "628": {"415"},
    "408": {"669"},
    "669": {"408"},
    "510": {"341"},
    "341": {"510"},
    // Phoenix
    "480": {"623", "602"},
    "602": {"480", "623"},
    "623": {"480", "602"},
    // Miami
    "305": {"786"},
    "786": {"305"},
    // Philadelphia
    "215": {"267", "445"},
    "267": {"215", "445"},
    "445": {"215", "267"},
    // Washington DC area
    "202": {""},   // DC-only, no overlay
    "301": {"240"},
    "240": {"301"},
    "703": {"571"},
    "571": {"703"},
    // Seattle
    "206": {"564"},
    "564": {"206"},
    "253": {"564"},
    // Denver
    "303": {"720"},
    "720": {"303"},
    // Boston
    "617": {"857"},
    "857": {"617"},
    // San Diego
    "619": {"858"},
    "858": {"619"},
    // Minneapolis
    "612": {"952", "763", "651"},
    "952": {"612"},
    "763": {"612"},
    "651": {"612"},
    // Portland OR
    "503": {"971"},
    "971": {"503"},
    // Las Vegas
    "702": {"725"},
    "725": {"702"},
}

func neighborNPAs(npa string) []string { return npaNeighbors[npa] }
```

---

## 5. Index Builder

### 5.1 Location

```
dialer/internal/originate/npa_index.go
```

The index builder runs as a goroutine inside the dialer process. It does not
require a new service.

### 5.2 Startup Rebuild

```go
func (b *NPAIndexBuilder) StartupRebuild(ctx context.Context) error {
    // Query all pools with local_presence_enabled=true
    pools, err := b.db.QueryLocalPresencePools(ctx)
    if err != nil { return err }
    for _, pool := range pools {
        // Check sentinel
        built, _ := b.valkey.Exists(ctx, sentinelKey(pool.TenantID, pool.ID))
        if built { continue }  // already indexed
        if err := b.RebuildPool(ctx, pool.TenantID, pool.ID); err != nil {
            b.log.Warn("npa_index: rebuild failed", "pool_id", pool.ID, "err", err)
        }
    }
    return nil
}
```

### 5.3 Incremental Update (event-driven)

```go
func (b *NPAIndexBuilder) HandlePoolMembershipEvent(ctx context.Context, msg PoolMembershipEvent) {
    npa := extractNPA(msg.DIDE164)
    state := b.tzResolver.StateForNPA(npa)
    npaK := npaKey(msg.TenantID, msg.PoolID, npa)
    stateK := stateKey(msg.TenantID, msg.PoolID, state)
    didStr := strconv.FormatInt(msg.DIDID, 10)

    pipe := b.valkey.Pipeline()
    switch msg.Event {
    case "did_added":
        pipe.SAdd(ctx, npaK, didStr)
        if state != "" { pipe.SAdd(ctx, stateK, didStr) }
    case "did_removed":
        pipe.SRem(ctx, npaK, didStr)
        if state != "" { pipe.SRem(ctx, stateK, didStr) }
    }
    pipe.Exec(ctx)
}
```

### 5.4 Full Pool Rebuild

```go
func (b *NPAIndexBuilder) RebuildPool(ctx context.Context, tenantID, poolID int64) error {
    dids, err := b.db.GetPoolDIDs(ctx, tenantID, poolID)  // SELECT id, e164 FROM did_numbers JOIN pool_dids
    if err != nil { return err }

    npaMap := make(map[string][]string)    // npa → []didID
    stateMap := make(map[string][]string)  // state → []didID

    for _, did := range dids {
        npa := extractNPA(did.E164)
        if isReservedNPA(npa) { continue }
        didStr := strconv.FormatInt(did.ID, 10)
        npaMap[npa] = append(npaMap[npa], didStr)
        if state := b.tzResolver.StateForNPA(npa); state != "" {
            stateMap[state] = append(stateMap[state], didStr)
        }
    }

    pipe := b.valkey.Pipeline()
    // Delete old keys for this pool (safe: SCAN pattern + DEL)
    // Then write new
    for npa, dids := range npaMap {
        pipe.SAdd(ctx, npaKey(tenantID, poolID, npa), dids...)
    }
    for state, dids := range stateMap {
        pipe.SAdd(ctx, stateKey(tenantID, poolID, state), dids...)
    }
    pipe.Set(ctx, sentinelKey(tenantID, poolID), "1", 24*time.Hour)
    _, err = pipe.Exec(ctx)
    return err
}
```

---

## 6. TypeScript Service Layer

The TypeScript side (`api/src/services/number-pool/local-presence.ts`) wraps
the same logic for use in admin preview and testing. It is NOT on the hot
originate path.

### 6.1 File Layout

```
api/src/services/number-pool/
  local-presence.ts        — NPA extraction, neighbor lookup, Valkey queries
  local-presence.test.ts   — unit tests (all tiers, edge cases)
api/src/routes/admin/number-pools/
  index.ts                 — existing X04 route; gains local_presence_enabled PATCH
api/test/local-presence/
  picker.test.ts           — integration test with real Valkey
  coverage.test.ts         — per-NPA coverage report test
```

### 6.2 TypeScript Function Signature

```typescript
// api/src/services/number-pool/local-presence.ts

export type MatchTier = 1 | 2 | 3 | 4;

export interface LocalPresencePickResult {
  didE164: string;
  didId: bigint;
  matchTier: MatchTier;
  matchNpa: string | null;
}

export async function pickCallerIdWithLocalPresence(
  tenantId: bigint,
  poolId: bigint,
  calledE164: string,
  valkey: ValkeyClient,
  db: PrismaClient,
  tzResolver: PhoneTzResolver,  // D03 service
): Promise<LocalPresencePickResult>
```

### 6.3 Coverage Report Helper

```typescript
// Returns per-NPA DID count for the pool — feeds admin UI
export async function getNpaCoverageReport(
  tenantId: bigint,
  poolId: bigint,
  valkey: ValkeyClient,
): Promise<Array<{ npa: string; state: string | null; didCount: number }>>
```

This runs SCAN on `t:{tid}:pool:{pid}:npa:*` keys and returns SCARD per key.
Used by the admin UI to surface "you have 0 DIDs in NPA 212 (NY)" warnings.

---

## 7. REST API Changes

### 7.1 PATCH `/api/admin/number-pools/:id`

Gains `local_presence_enabled` boolean field. No new route — added to X04's
existing PATCH handler.

Request body addition:
```json
{ "local_presence_enabled": true }
```

On enable: triggers `NPAIndexBuilder.RebuildPool` asynchronously.

### 7.2 GET `/api/admin/number-pools/:id/npa-coverage`

Returns the per-NPA coverage report.

Response:
```json
{
  "pool_id": 7,
  "local_presence_enabled": true,
  "coverage": [
    { "npa": "415", "state": "CA", "did_count": 3 },
    { "npa": "650", "state": "CA", "did_count": 1 },
    { "npa": "212", "state": "NY", "did_count": 0 }
  ],
  "uncovered_npa_count": 1
}
```

The `uncovered_npa_count` field counts NPAs seen in recent call attempts
(from `originate_audit.phone_e164`) that had no DIDs in the pool — requires
a secondary query on `originate_audit` partitioned table. Phase-2 feature;
Phase-1 returns coverage of indexed NPAs only.

---

## 8. Metrics

### 8.1 Prometheus Counters

```
vici2_x05_match_tier_total{tenant_id, pool_id, tier}
  — incremented on each pickCallerID call; tier = "exact_npa"|"neighbor_npa"|"same_state"|"pool_fallback"

vici2_x05_index_build_total{tenant_id, pool_id, trigger}
  — trigger = "startup"|"event"|"cold_start"

vici2_x05_index_build_duration_seconds{tenant_id, pool_id}
  — histogram; build latency

vici2_x05_reserved_npa_skip_total{tenant_id}
  — calls where calledE164 NPA was reserved (toll-free etc.)

vici2_x05_all_quarantined_total{tenant_id, pool_id, tier}
  — times a tier had candidates but all were quarantined
```

### 8.2 Valkey Key Cardinality

At 10 pools × 300 NPAs per pool × 1 tenant = 3,000 NPA SET keys.
At 10 pools × 52 states per pool × 1 tenant = 520 state SET keys.
Total: ~3,520 Valkey keys per tenant for X05 indexes. Negligible.

---

## 9. Acceptance Criteria

- [ ] **AC-1 Exact NPA match:** Lead in NPA 415; pool has a 415 DID; that DID is
  selected. Verified by unit test and integration test.

- [ ] **AC-2 Neighbor NPA match:** Lead in NPA 212; pool has a 646 DID (overlay)
  but no 212 DID; 646 DID is selected at Tier 2. Verified by unit test.

- [ ] **AC-3 Same-state match:** Lead in NPA 408 (San Jose, CA); pool has a 619 DID
  (San Diego, CA) but no 408 or overlay DID; 619 DID selected at Tier 3.

- [ ] **AC-4 Fallback:** No matching DID in Tiers 1–3; X04 pool fallback (Tier 4)
  used. Verified by unit test with empty NPA/state index.

- [ ] **AC-5 Quarantine skip:** All Tier-1 candidates are quarantined; algorithm
  falls through to Tier 2 (or lower). Verified by unit test.

- [ ] **AC-6 Reserved NPA skip:** Lead with toll-free NPA (800, 888, etc.) skips
  directly to Tier 4. Verified by unit test.

- [ ] **AC-7 Feature flag:** Pool with `local_presence_enabled=false` takes the
  X04 code path directly; no Valkey NPA lookup performed. Verified by mock
  asserting zero Valkey calls.

- [ ] **AC-8 Latency:** End-to-end `PickCallerID` call in worst-case (all 4 tiers
  checked, Valkey on loopback) completes in ≤5ms. Verified by benchmark test
  in Go (`BenchmarkPickCallerID`).

- [ ] **AC-9 Index build on startup:** On dialer restart with
  `local_presence_enabled=true` pool and missing sentinel, index is rebuilt
  before first originate attempt completes. Verified by integration test.

- [ ] **AC-10 Event-driven update:** Adding a DID to a pool via X04 API causes
  the DID's NPA SET to be updated within 500ms (event consumer latency).
  Verified by integration test with real Valkey pub/sub.

- [ ] **AC-11 match_tier metric:** After 100 calls with mix of Tier 1/2/3/4
  outcomes, Prometheus counters match the distribution. Verified by integration
  test asserting counter values.

- [ ] **AC-12 originate_audit.cid_match_tier populated:** Rows in `originate_audit`
  have `cid_match_tier` set to 1–4 when X05 is active; NULL when disabled.

- [ ] **AC-13 Coverage report:** `GET /api/admin/number-pools/:id/npa-coverage`
  returns correct DID counts per NPA. Verified by integration test.

- [ ] **AC-14 Toll-free DID exclusion at index build:** A pool containing a DID
  with NPA 800 does not add that DID to any NPA SET. Verified by unit test.

- [ ] **AC-15 No schema breakage:** Existing X04 tests continue to pass with no
  changes required.

---

## 10. File Layout

### 10.1 Go (Dialer)

```
dialer/internal/originate/
  pick_caller.go           — PickCallerID() function (extends X04's pickCaller.go)
  pick_caller_test.go      — unit + benchmark tests
  npa_index.go             — NPAIndexBuilder struct + methods
  npa_index_test.go        — builder unit tests
  npa_neighbors.go         — neighborNPAs static map (embedded)
  reserved_npa.go          — isReservedNPA() and reservedNPAs map
```

### 10.2 TypeScript (API)

```
api/src/services/number-pool/
  local-presence.ts        — TypeScript wrapper + coverage report
api/src/routes/admin/number-pools/
  index.ts                 — existing X04 route; gains local_presence_enabled field
  npa-coverage.ts          — new route handler for coverage report
api/test/local-presence/
  picker.test.ts           — integration tests (Valkey + MySQL)
  coverage.test.ts         — coverage report tests
```

### 10.3 Migrations

```
api/prisma/migrations/20260513260000_x05_local_presence/migration.sql
```

### 10.4 Files NOT created

- No new service binary
- No new docker-compose service
- No new Prometheus rule file (metrics added to existing dialer scrape target)
- No new admin UI component (coverage report is JSON; UI in future M08 sprint)

---

## 11. LOC Estimate

| File | Estimated LOC | Notes |
|---|---|---|
| `pick_caller.go` | 120 | Extends X04; ~60 lines new |
| `pick_caller_test.go` | 80 | 15 test cases |
| `npa_index.go` | 110 | Builder + event handler |
| `npa_index_test.go` | 60 | Unit tests |
| `npa_neighbors.go` | 70 | Static map, 60+ entries |
| `reserved_npa.go` | 20 | Map + predicate |
| `local-presence.ts` | 80 | TypeScript wrapper |
| `npa-coverage.ts` | 30 | Route handler |
| `local-presence test files` | 80 | Integration tests |
| `migration.sql` | 10 | Two ALTER TABLE statements |
| **Total** | **~660** | ~280 truly new (X05-specific); ~380 reuse/extend from X04 |

---

## 12. Phase Plan

### Phase A — Schema and Valkey foundation (Day 1)

- Write and apply migration (`20260513260000_x05_local_presence`)
- Add `localPresenceEnabled` to Prisma model
- Implement `reserved_npa.go` and `npa_neighbors.go`
- Implement `NPAIndexBuilder.RebuildPool` with unit tests
- Implement `NPAIndexBuilder.HandlePoolMembershipEvent` with unit tests
- Wire index builder goroutine into dialer startup

### Phase B — Picker implementation (Day 2)

- Implement `PickCallerID` with four-tier logic
- Implement `sampleHealthyDID` with quarantine pipeline
- Implement `BenchmarkPickCallerID` and assert ≤5ms
- Wire Prometheus metrics
- Implement `pick_caller_test.go` (AC-1 through AC-11)

### Phase C — TypeScript layer and REST (Day 3)

- Implement `local-presence.ts` TypeScript wrapper
- Implement `npa-coverage.ts` route handler
- Add `local_presence_enabled` field to X04 PATCH handler
- Implement integration tests (`picker.test.ts`, `coverage.test.ts`)
- Wire `cid_match_tier` into T04 originate path (requires T04 PLAN review)

### Phase D — Acceptance and handoff (Day 4)

- Run all 15 acceptance criteria; record results in VERIFY.md
- Write HANDOFF.md
- Update X04 HANDOFF.md to reference X05 extension points
- Open PR

---

## 13. Dependency Contracts with X04

X05 depends on X04 for the following (these must be FROZEN in X04 PLAN before
X05 IMPLEMENT begins):

1. **`number_pools` table exists** with `id`, `tenant_id`, `active` columns.
   X05 adds `local_presence_enabled`.

2. **`pool_dids` join table** (or equivalent) exposing `pool_id → did_id`
   relationship. X05's `RebuildPool` queries this.

3. **`t:{tid}:pool-membership:events` pub/sub channel** published by X04's
   pool service on DID add/remove. Message schema must match §3.4.

4. **`t:{tid}:pool:{pid}:did:{did_id}:quarantined` key convention** from X04
   health module. X05 checks existence of this key.

5. **`x04Fallback()` / `pickCallerIdFromPool()` call contract** — X05 calls
   X04's existing picker as Tier 4. X04 picker must remain callable with the
   same signature.

If any of these five contracts change in X04 PLAN, X05 PLAN must be updated
accordingly before IMPLEMENT.

---

## 14. Open Items Before IMPLEMENT

1. Confirm X04 PLAN is frozen (blocking).
2. Confirm T04 originate path can accept `cid_match_tier` from picker result
   and write it to `originate_audit` (requires T04 PLAN review).
3. Confirm F04 PLAN confirms the `t:{tid}:pool-membership:events` channel
   convention (or define it jointly with X04 PLAN).
4. Decide whether `npa_neighbors.go` should be a Valkey HASH (admin-editable)
   from day one or remain embedded map (Phase-2 upgrade). Current decision:
   embedded map, Phase-1.
5. Confirm D03's `StateForNPA()` is available in the Go dialer process.
   D03 is currently TypeScript only. Options: (a) embed a lightweight NPA→state
   map in Go from the same NANPA seed data, (b) call D03 as a gRPC microservice
   (latency concern), (c) read `phone_codes` from MySQL at startup into a
   Go in-process map. Decision: option (c) — load `phone_codes` into a Go
   `sync.Map` at startup; refresh every 24h. This is consistent with D03's
   "full in-memory cache" design documented in D03.md.
