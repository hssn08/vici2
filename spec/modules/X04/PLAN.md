# X04 — Number Pool + Rotation: Implementation Plan

| Field             | Value                                         |
|-------------------|-----------------------------------------------|
| Module            | X04 — Number Pool + Rotation                 |
| Track             | Scale-out / Reputation                        |
| Phase             | 3.5                                           |
| Effort            | 4–5 days                                      |
| LOC estimate      | ~1,400 lines                                  |
| Migration stamp   | 20260513300000                                |
| Owner agent type  | backend-node + Go                             |
| Status            | PLANNED                                       |

---

## 1. Goals

1. Manage named **number pools** — ordered lists of DIDs associated with a campaign.
2. **Rotate** caller-ID across the pool on every outbound call using a health-weighted,
   LRU-biased algorithm to minimize the chance that any single number accrues enough volume
   to trigger "Spam Likely" labeling.
3. **Track per-number health metrics**: answer rate (7d rolling), complaint proxy rate (30d),
   daily call count, concurrent calls, age, last-used timestamp.
4. **Auto-quarantine** numbers that breach configurable thresholds; require manual unquarantine.
5. Expose **admin CRUD** for pools and pool membership, plus a **per-number stats view**.
6. Define clean **public service contract** consumed by X05 (local-presence) via an
   `areaCodeFilter` parameter extension.

---

## 2. Non-Goals (Phase 3.5)

- Automatic DID provisioning from carrier APIs (flagged for X06).
- Direct complaint-rate feeds from Hiya/TNS APIs (flagged for X07).
- STIR/SHAKEN attestation auto-detection via Identity header parsing (flagged for X07).
- Multi-region FreeSWITCH pool sharding (X03 concern).
- Pool sharing across tenants (prohibited by design).

---

## 3. Schema

### 3.1 New Table: `number_pools`

```sql
CREATE TABLE number_pools (
  id              BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED    NOT NULL DEFAULT 1,
  name            VARCHAR(128)       NOT NULL,
  description     TEXT               NULL,

  -- Rotation strategy
  strategy        ENUM(
    'health_weighted_lru',   -- default: LRU + health weighting
    'round_robin',
    'random',
    'least_recently_used'
  ) NOT NULL DEFAULT 'health_weighted_lru',

  -- Quarantine thresholds (pool-level overrides)
  ar_floor        DECIMAL(5,4)   NOT NULL DEFAULT 0.0800,  -- 8% min answer rate
  ar_min_sample   INT UNSIGNED   NOT NULL DEFAULT 200,     -- calls needed before AR quarantine
  cr_ceil         DECIMAL(5,4)   NOT NULL DEFAULT 0.0500,  -- 5% complaint proxy ceiling
  cr_min_sample   INT UNSIGNED   NOT NULL DEFAULT 100,     -- calls needed before CR quarantine
  daily_cap       SMALLINT UNSIGNED NOT NULL DEFAULT 200,  -- calls/day/number before exclusion

  -- Pool health management
  min_active_size TINYINT UNSIGNED NOT NULL DEFAULT 3,     -- warn below this active count

  -- Concurrent call cap per number
  max_concurrent  TINYINT UNSIGNED NOT NULL DEFAULT 5,

  active          BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                 ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_pools_tenant_name (tenant_id, name),
  KEY idx_pools_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model name**: `NumberPool` → `@@map("number_pools")`

### 3.2 New Table: `number_pool_dids`

```sql
CREATE TABLE number_pool_dids (
  id              BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
  pool_id         BIGINT UNSIGNED    NOT NULL,
  did_id          BIGINT UNSIGNED    NOT NULL,
  tenant_id       BIGINT UNSIGNED    NOT NULL DEFAULT 1,

  -- Area code (denormalized from did_numbers.e164 for fast local-presence filter)
  area_code       CHAR(3)            NOT NULL DEFAULT '',

  -- Quarantine (pool-membership scoped)
  quarantined     BOOLEAN            NOT NULL DEFAULT FALSE,
  quarantined_at  DATETIME(6)        NULL,
  quarantine_reason ENUM(
    'low_answer_rate',
    'high_complaint_rate',
    'manual',
    'label_detected'        -- reserved for X07
  ) NULL,
  quarantine_meta JSON               NULL,   -- {ar: 0.05, sample: 324, ...}

  -- Warm-up tracking
  first_used_at   DATETIME(6)        NULL,   -- NULL = never used
  last_used_at    DATETIME(6)        NULL,   -- NULL = never used

  -- Rotation state (for round-robin cursor; cross-pod in Valkey — see §6)
  -- seq_pos column intentionally omitted: cursor lives in Valkey.

  -- Aggregate health stats (updated by quarantine reaper)
  call_count_7d   INT UNSIGNED       NOT NULL DEFAULT 0,
  answer_count_7d INT UNSIGNED       NOT NULL DEFAULT 0,
  call_count_30d  INT UNSIGNED       NOT NULL DEFAULT 0,
  short_call_count_30d INT UNSIGNED  NOT NULL DEFAULT 0,  -- proxy for complaint rate
  complaint_count_30d  INT UNSIGNED  NOT NULL DEFAULT 0,  -- from manual/API feed
  health_score    TINYINT UNSIGNED   NOT NULL DEFAULT 100, -- [0,100]

  -- Attestation level (admin-configured; X07 may auto-detect)
  attest_level    ENUM('A','B','C','unknown') NOT NULL DEFAULT 'unknown',

  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                 ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_pool_did (pool_id, did_id),
  KEY idx_npd_tenant_pool (tenant_id, pool_id, quarantined, health_score),
  KEY idx_npd_did (did_id),
  KEY idx_npd_area_code (pool_id, area_code, quarantined),

  CONSTRAINT fk_npd_pool FOREIGN KEY (pool_id)
    REFERENCES number_pools (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_npd_did  FOREIGN KEY (did_id)
    REFERENCES did_numbers (id) ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model name**: `NumberPoolDid` → `@@map("number_pool_dids")`

### 3.3 Amendment to `campaigns` table

```sql
ALTER TABLE campaigns
  ADD COLUMN number_pool_id BIGINT UNSIGNED NULL DEFAULT NULL
             COMMENT 'X04: FK to number_pools.id; if set, overrides campaign CID waterfall tier 4',
  ADD CONSTRAINT fk_campaigns_number_pool
    FOREIGN KEY (number_pool_id) REFERENCES number_pools (id)
    ON DELETE SET NULL ON UPDATE NO ACTION;
```

**Prisma amendment** (add to Campaign model):
```prisma
numberPoolId BigInt? @map("number_pool_id")
numberPool   NumberPool? @relation(fields: [numberPoolId], references: [id],
               onDelete: SetNull, onUpdate: NoAction, map: "fk_campaigns_number_pool")
```

### 3.4 Amendment to `did_numbers` table (per-number daily bucket counters)

Rather than querying `number_pool_dids` on every originate, daily counters are maintained in
Valkey only (see §6). The only DB columns added to `did_numbers` are the daily cap marker — no
extra DB amendments needed; Valkey handles ephemeral counters.

---

## 4. Migration

**Filename**: `api/prisma/migrations/20260513300000_x04_number_pools/migration.sql`

Contents:
1. CREATE TABLE `number_pools` (§3.1).
2. CREATE TABLE `number_pool_dids` (§3.2).
3. ALTER TABLE `campaigns` ADD COLUMN `number_pool_id` + FK (§3.3).

Prisma schema file: `api/prisma/schema.prisma` — add `NumberPool`, `NumberPoolDid` models and
`numberPool` relation on `Campaign`.

---

## 5. API Layer

### 5.1 Route Overview

All routes require auth + `number_pool:read` or `number_pool:edit` RBAC verbs.

```
GET    /api/admin/number-pools                    number_pool:read   list pools
POST   /api/admin/number-pools                    number_pool:edit   create pool
GET    /api/admin/number-pools/:id                number_pool:read   get pool
PATCH  /api/admin/number-pools/:id                number_pool:edit   update pool
DELETE /api/admin/number-pools/:id                number_pool:edit   delete pool (soft: active=false)

GET    /api/admin/number-pools/:id/dids           number_pool:read   list members
POST   /api/admin/number-pools/:id/dids           number_pool:edit   add DID to pool
DELETE /api/admin/number-pools/:id/dids/:didId    number_pool:edit   remove DID from pool

GET    /api/admin/number-pools/:id/dids/:didId/stats  number_pool:read  per-number stats
POST   /api/admin/number-pools/:id/dids/:didId/quarantine  number_pool:edit  manual quarantine
POST   /api/admin/number-pools/:id/dids/:didId/unquarantine number_pool:edit  manual unquarantine

GET    /api/admin/number-pools/:id/stats          number_pool:read   pool-level aggregate stats
```

**Note**: `number_pool:read` and `number_pool:edit` are new RBAC verbs to be added to
`shared/types/src/rbac.ts` (see §8).

### 5.2 File Structure

```
api/src/routes/admin/number-pools/
  index.ts          — route registration (registerAdminNumberPoolRoutes)
  schema.ts         — Zod validators + TypeScript interfaces
  service.ts        — business logic (CRUD + quarantine + stats)
  did-service.ts    — DID membership management
  stats-service.ts  — health score computation + stats aggregation
```

### 5.3 Key Request/Response Shapes

**Pool Create** (`POST /api/admin/number-pools`):
```typescript
{
  name: string;           // 1–128 chars
  description?: string;
  strategy: 'health_weighted_lru' | 'round_robin' | 'random' | 'least_recently_used';
  arFloor?: number;       // default 0.08
  arMinSample?: number;   // default 200
  crCeil?: number;        // default 0.05
  crMinSample?: number;   // default 100
  dailyCap?: number;      // default 200
  minActiveSize?: number; // default 3
  maxConcurrent?: number; // default 5
}
```

**Pool Response**:
```typescript
{
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  strategy: string;
  arFloor: number;
  arMinSample: number;
  crCeil: number;
  crMinSample: number;
  dailyCap: number;
  minActiveSize: number;
  maxConcurrent: number;
  active: boolean;
  activeDids: number;       // count of non-quarantined members
  quarantinedDids: number;  // count of quarantined members
  createdAt: string;
  updatedAt: string;
}
```

**Add DID** (`POST /api/admin/number-pools/:id/dids`):
```typescript
{ didId: string; attestLevel?: 'A' | 'B' | 'C' | 'unknown'; }
```

**DID Member Response**:
```typescript
{
  id: string;             // number_pool_dids.id
  poolId: string;
  didId: string;
  e164: string;           // joined from did_numbers
  areaCode: string;
  quarantined: boolean;
  quarantinedAt: string | null;
  quarantineReason: string | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  callCount7d: number;
  answerCount7d: number;
  answerRate7d: number;   // derived: answerCount7d / callCount7d
  callCount30d: number;
  shortCallCount30d: number;
  complaintCount30d: number;
  healthScore: number;
  attestLevel: string;
  dailyCallCount: number; // from Valkey counter (live)
  concurrentCalls: number; // from Valkey counter (live)
  createdAt: string;
  updatedAt: string;
}
```

**Pool Stats Response** (`GET /api/admin/number-pools/:id/stats`):
```typescript
{
  poolId: string;
  totalDids: number;
  activeDids: number;
  quarantinedDids: number;
  avgHealthScore: number;
  avgAnswerRate7d: number;
  totalCallsToday: number;   // sum of Valkey daily counters
  activeCallsNow: number;    // sum of Valkey concurrent counters
  belowMinActiveSize: boolean;
}
```

### 5.4 Service Implementation Notes

**`service.ts`**:
- `listPools(tenantId, query)` — paginated, filter by `active`.
- `createPool(tenantId, actorId, input)` — validates name uniqueness; emits `number_pool.created`.
- `getPool(tenantId, id)` — with active/quarantined DID counts joined.
- `updatePool(tenantId, actorId, id, input)` — partial update; emits `number_pool.updated`.
- `deletePool(tenantId, actorId, id)` — sets `active = false` (soft delete); refuses if any
  campaign references this pool (returns 409). Emits `number_pool.deleted`.

**`did-service.ts`**:
- `listPoolDids(tenantId, poolId, query)` — paginated; enriches with live Valkey counters.
- `addDidToPool(tenantId, actorId, poolId, didId, attestLevel)`:
  - Verifies `did_numbers.tenant_id == tenantId`.
  - Extracts `area_code` from `e164` (chars 2–4 for US E.164 format `+1NXX...`).
  - Inserts `number_pool_dids` row.
  - Invalidates pool cache in Valkey (publishes `pool:{pool_id}:invalidate` message).
  - Emits `number_pool.did.added` audit.
- `removeDidFromPool(tenantId, actorId, poolId, didId)`:
  - Deletes `number_pool_dids` row.
  - Invalidates pool cache.
  - Emits `number_pool.did.removed` audit.
- `quarantineDid(tenantId, actorId, poolId, didId, reason?, meta?)`:
  - Sets `quarantined = true`, `quarantined_at = NOW()`, `quarantine_reason`.
  - Invalidates pool cache.
  - Emits `number_pool.did.quarantined` audit.
- `unquarantineDid(tenantId, actorId, poolId, didId)`:
  - Sets `quarantined = false`, `quarantined_at = NULL`, `quarantine_reason = NULL`.
  - Invalidates pool cache.
  - Emits `number_pool.did.unquarantined` audit.

**`stats-service.ts`**:
- `getPoolStats(tenantId, poolId, valkey)` — aggregates DB stats + Valkey counters.
- `getDIDStats(tenantId, poolId, didId, valkey)` — single number stats with live counters.

---

## 6. Valkey Key Namespace (X04 additions)

All keys follow the `t:{tid}:pool:{pid}:*` convention with `{pid}` as the Valkey cluster
hash-tag, colocating all pool keys for a given pool on the same shard.

```
t:{tid}:pool:{pid}:rr_cursor          STRING   INT   round-robin cursor (INCR; no TTL)
t:{tid}:pool:{pid}:members            STRING   JSON  cached active member list (health_score, last_used)
t:{tid}:pool:{pid}:invalidate         CHANNEL        pub/sub: dialer processes listen to reload cache

t:{tid}:did:{did_id}:daily_calls      STRING   INT   calls today (INCR; TTL = seconds until midnight UTC)
t:{tid}:did:{did_id}:concurrent       STRING   INT   concurrent calls (INCR on originate, DECR on hangup)
```

**`keys.go` additions** (in `dialer/internal/valkey/keys.go`):

```go
func (k Keys) PoolRRCursor(poolID int64) string {
    return fmt.Sprintf("t:%d:pool:{%d}:rr_cursor", k.tid, poolID)
}
func (k Keys) PoolMembers(poolID int64) string {
    return fmt.Sprintf("t:%d:pool:{%d}:members", k.tid, poolID)
}
func (k Keys) PoolInvalidate(poolID int64) string {
    return fmt.Sprintf("t:%d:pool:{%d}:invalidate", k.tid, poolID)
}
func (k Keys) DIDDailyCalls(didID int64) string {
    return fmt.Sprintf("t:%d:did:{%d}:daily_calls", k.tid, didID)
}
func (k Keys) DIDConcurrent(didID int64) string {
    return fmt.Sprintf("t:%d:did:{%d}:concurrent", k.tid, didID)
}
```

**Daily counter TTL computation**: `ttlSeconds = (23:59:59 UTC - now UTC).seconds + 1`.
Set on INCR only if the key did not exist (use `SET NX EX` pattern or `SET key 0 EX ttl` + INCR).

---

## 7. Go Pool Picker (dialer)

### 7.1 New Package: `dialer/internal/pool/`

```
dialer/internal/pool/
  types.go          — PoolMember, PoolConfig structs
  picker.go         — PickFromPool() implementation
  cache.go          — in-process member list cache (invalidated via Valkey pub/sub)
  metrics.go        — Prometheus metrics
  picker_test.go    — unit tests
```

### 7.2 `types.go`

```go
package pool

// PoolMember is a single DID entry in the in-process cache.
type PoolMember struct {
    NPID        int64   // number_pool_dids.id
    DidID       int64
    E164        string
    AreaCode    string
    HealthScore uint8   // [0, 100]
    LastUsedAt  int64   // Unix timestamp; 0 = never
    Quarantined bool
    AttestLevel string  // "A", "B", "C", "unknown"
}

// PoolConfig is the pool-level configuration cached alongside members.
type PoolConfig struct {
    Strategy     string
    DailyCap     int
    MaxConcurrent int
    ARFloor      float64
    ARMinSample  int
}

// PickRequest is passed to PickFromPool.
type PickRequest struct {
    PoolID       int64
    TenantID     int64
    AreaCodeHint string  // "" = no filter (non-local-presence); X05 passes 3-digit area code
}

// PickResult is returned by PickFromPool.
type PickResult struct {
    E164    string
    DidID   int64
    NPID    int64   // number_pool_dids.id (for recording last_used_at)
    Source  string  // "pool:{pool_id}" for CidSource label
}
```

### 7.3 `picker.go` — PickFromPool Algorithm

```go
// PickFromPool selects a caller-ID number from the named pool.
// It enforces: quarantine exclusion, daily cap, concurrent cap, area-code filter.
// Returns ErrPoolEmpty if no eligible member exists.
func (s *Service) PickFromPool(ctx context.Context, req PickRequest) (*PickResult, error) {
    members, config, err := s.cache.Get(ctx, req.TenantID, req.PoolID)
    if err != nil {
        return nil, fmt.Errorf("pool: cache miss: %w", err)
    }

    eligible := filterMembers(members, req, config)
    if len(eligible) == 0 {
        poolPickEmpty.WithLabelValues(strconv.FormatInt(req.PoolID, 10)).Inc()
        return nil, ErrPoolEmpty
    }

    var picked *PoolMember
    switch config.Strategy {
    case "round_robin":
        picked = pickRoundRobin(ctx, eligible, req, s.valkey)
    case "random":
        picked = pickRandom(eligible)
    case "least_recently_used":
        picked = pickLRU(eligible)
    default: // health_weighted_lru
        picked = pickHealthWeightedLRU(eligible)
    }

    if picked == nil {
        return nil, ErrPoolEmpty
    }

    // Increment concurrent counter (decremented by pool.Release on call hangup)
    s.valkey.Incr(ctx, s.keys.DIDConcurrent(picked.DidID))

    // Increment daily counter (SETNX + INCR with midnight TTL)
    incrDailyCounter(ctx, s.valkey, s.keys.DIDDailyCalls(picked.DidID))

    poolPickTotal.WithLabelValues(strconv.FormatInt(req.PoolID, 10), config.Strategy).Inc()

    return &PickResult{
        E164:   picked.E164,
        DidID:  picked.DidID,
        NPID:   picked.NPID,
        Source: fmt.Sprintf("pool:%d", req.PoolID),
    }, nil
}
```

**`filterMembers`**: removes quarantined, daily-cap-exceeded (Valkey counter ≥ config.DailyCap),
concurrent-cap-exceeded (Valkey counter ≥ config.MaxConcurrent), and (if AreaCodeHint != "")
non-matching area codes.

**`pickHealthWeightedLRU`**: 
1. Score each member: `w = float64(m.HealthScore) / (1.0 + float64(now-m.LastUsedAt)/3600.0)`
   — health divided by hours since last use (decays weight of recently-used numbers).
2. Normalize weights to [0, totalWeight].
3. Pick `rand.Float64() * totalWeight`, binary search cumulative array.

**`pickRoundRobin`**: `INCR t:{tid}:pool:{pid}:rr_cursor` → `mod len(eligible)` → `eligible[idx]`.

**`Release(ctx, didID int64)`**: called by originate on call HANGUP.
```go
func (s *Service) Release(ctx context.Context, tenantID, didID int64) {
    s.valkey.Decr(ctx, s.keys.DIDConcurrent(didID))
}
```

### 7.4 `cache.go` — In-Process Cache

The cache stores `(members []PoolMember, config PoolConfig)` per `(tenantID, poolID)`. It is
loaded on first access from MySQL (via the shared `*sql.DB` handle). It is invalidated by a
Valkey pub/sub subscription to the `PoolInvalidate(poolID)` channel.

Cache TTL: 5 minutes (backstop even if pub/sub misses a message). On invalidation the next
`Get()` call re-loads from MySQL.

Thread safety: `sync.RWMutex` per pool entry, or a sharded cache (16 shards, hash of poolID).

### 7.5 Integration with `cid_picker.go`

Modify `dialer/internal/originate/cid_picker.go`:

```go
// PickCallerID runs the 4-tier caller-ID waterfall.
func PickCallerID(ctx context.Context, req *OriginateRequest, poolSvc PoolPicker) (
    number, name string, source OriginateCidSource, err error,
) {
    // Tier 1: per-call override
    if req.CallerIDOverride != "" {
        return req.CallerIDOverride, req.CallerIDName, CidSourcePerCall, nil
    }

    // Tier 2: per-list override
    if req.ListCallerID != nil && *req.ListCallerID != "" {
        return *req.ListCallerID, "", CidSourcePerList, nil
    }

    // Tier 3: number pool (X04) / local-presence (X05)
    if req.NumberPoolID != 0 && poolSvc != nil {
        res, pickErr := poolSvc.PickFromPool(ctx, pool.PickRequest{
            PoolID:       req.NumberPoolID,
            TenantID:     req.TenantID,
            AreaCodeHint: req.LocalPresenceAreaCode, // X05 sets this
        })
        if pickErr == nil {
            return res.E164, "", CidSourceLocalPresence, nil
        }
        // On ErrPoolEmpty: fall through to Tier 4 (log warning).
        slog.WarnContext(ctx, "pool empty, falling back to campaign CID",
            "pool_id", req.NumberPoolID, "err", pickErr)
    }

    // Tier 4: campaign default
    if req.CallerIDCampaign != "" {
        return req.CallerIDCampaign, "", CidSourceCampaignDflt, nil
    }

    return "", "", "", fmt.Errorf("originate: no caller-id available for campaign %s", req.CampaignID)
}

// PoolPicker is the interface expected by PickCallerID.
type PoolPicker interface {
    PickFromPool(ctx context.Context, req pool.PickRequest) (*pool.PickResult, error)
}
```

**New fields on `OriginateRequest`** (`request.go`):
```go
NumberPoolID          int64   // X04: 0 = no pool
LocalPresenceAreaCode string  // X05: "" = no area-code filter
```

### 7.6 Call Outcome Recording (for health stats)

After each call completes, the existing `record_call_outcome.v1.lua` Lua script (or a new Lua
script) must update the per-pool-membership stats. Since this is high-frequency, it happens
asynchronously via the existing workers FreeSWITCH event router job.

In `workers/src/jobs/freeswitch-event-router/index.ts`, add handling for:
- `CHANNEL_HANGUP_COMPLETE` events where `vici2_pool_npid` channel var is set (the NPID of the
  pool membership that supplied the CID).
- On each such event:
  - Increment `call_count_7d` + `call_count_30d` on the `number_pool_dids` row.
  - If `billsec >= 4`, increment `answer_count_7d`.
  - If `0 < billsec < 4` AND `answered`, increment `short_call_count_30d`.

The `vici2_pool_npid` channel var must be set in `chanvars.go` when `CidSourceLocalPresence`
was used and the result came from the pool picker (NPID stored in `GateScratch.PoolNPID`).

---

## 8. Workers — Quarantine Reaper

### 8.1 Job: `workers/src/jobs/number-pool-reaper/`

```
workers/src/jobs/number-pool-reaper/
  index.ts          — job registration
  reaper.ts         — quarantine evaluation + stats rollup
  metrics.ts        — Prometheus counters
```

**Schedule**: 1-hour cron (`0 * * * *`) registered in `workers/src/index.ts`.

**Reaper logic** (`reaper.ts`):

```typescript
export async function runReaper(db: PrismaClient, now: Date): Promise<void> {
  // 1. Load all active pool memberships grouped by pool
  const memberships = await db.numberPoolDid.findMany({
    where: { quarantined: false },
    include: { pool: true, did: { select: { e164: true } } },
  });

  for (const m of memberships) {
    const pool = m.pool;
    const arSample = m.callCount7d;
    const ar = arSample > 0 ? m.answerCount7d / arSample : null;
    const crSample = m.callCount30d;
    const cr = crSample > 0 ? m.shortCallCount30d / crSample : null;

    let shouldQuarantine = false;
    let reason: QuarantineReason | null = null;
    let meta: Record<string, unknown> = {};

    // AR check
    if (ar !== null && arSample >= pool.arMinSample && ar < pool.arFloor) {
      shouldQuarantine = true;
      reason = 'low_answer_rate';
      meta = { ar, sample: arSample, floor: pool.arFloor };
    }

    // CR check (only if not already quarantining for AR)
    if (!shouldQuarantine && cr !== null && crSample >= pool.crMinSample && cr > pool.crCeil) {
      shouldQuarantine = true;
      reason = 'high_complaint_rate';
      meta = { cr, sample: crSample, ceil: pool.crCeil };
    }

    // Compute health score regardless
    const healthScore = computeHealthScore(ar, cr, m.attestLevel);

    if (shouldQuarantine) {
      await quarantineMembership(db, m.id, reason!, meta, now);
      reaperQuarantined.inc();
    } else {
      // Update health score only
      await db.numberPoolDid.update({
        where: { id: m.id },
        data: { healthScore, updatedAt: now },
      });
    }
  }

  // 2. Check each pool for below-min-active-size and emit alert if needed
  await checkPoolSizes(db, now);

  // 3. Prune call_count_7d for memberships unused in 8+ days (slide window)
  await pruneStaleCounters(db, now);
}
```

**`computeHealthScore(ar, cr, attestLevel)`**:
```typescript
function computeHealthScore(
  ar: number | null,
  cr: number | null,
  attest: string,
): number {
  const arScore = ar !== null ? Math.min(ar / 0.25, 1.0) : 0.5;
  const crScore = cr !== null ? Math.max(1.0 - cr / 0.05, 0) : 0.8;
  const attestBonus = { A: 1.0, B: 0.7, C: 0.3, unknown: 0.5 }[attest] ?? 0.5;
  const composite = 0.40 * arScore + 0.25 * crScore + 0.35 * attestBonus;
  return Math.round(composite * 100);
}
```

### 8.2 `checkPoolSizes`

Queries each pool's active member count. If < `pool.minActiveSize`, emit an alert via O03
alerting infrastructure (insert into `alert_events` table with `event_type = 'pool.below_min_size'`).

---

## 9. Admin UI

### 9.1 Next.js App Router Pages

```
web/src/app/(admin)/number-pools/
  page.tsx              — Pool list (table: name, strategy, active DIDs, quarantined DIDs, avg health)
  new/page.tsx          — Create pool form
  [id]/
    page.tsx            — Pool detail: overview + DID member table + quarantine queue
    edit/page.tsx       — Edit pool settings
    stats/page.tsx      — Aggregate stats (charts: answer rate trend, calls/day by number)
```

### 9.2 Pool List (`page.tsx`)

Columns:
- Name (link to detail)
- Strategy
- Active DIDs / Quarantined DIDs
- Avg Health Score (color-coded: green >75, yellow 40–75, red <40)
- Below Min Size? (badge)
- Actions: Edit, Delete

### 9.3 Pool Detail (`[id]/page.tsx`)

Two tabs:
1. **Members**: sortable table of DID members.
   Columns: E.164, Area Code, Health Score (gauge), Answer Rate (7d), Daily Calls, Concurrent,
   Last Used, Attest, Quarantined (badge), Actions (Quarantine / Unquarantine / Remove).
2. **Settings**: pool configuration (strategy, thresholds).

Quarantine action: confirmation dialog showing current metrics; POST to
`/api/admin/number-pools/:id/dids/:didId/quarantine`.

### 9.4 DID Selector for Adding Members

The "Add DID" button opens a modal with a searchable DID picker (calls
`GET /api/admin/dids?active=true&search=...`) filtered to DIDs not already in the pool.
Attestation level can be set on add.

### 9.5 Campaign Pool Assignment

On the Campaign edit page (`(admin)/campaigns/[id]/edit`), add a "Number Pool" select field
(optional) that fetches `GET /api/admin/number-pools?active=true` for the dropdown.
Setting this field POSTes `PATCH /api/admin/campaigns/:id` with `{ numberPoolId: "..." }`.

This requires adding `numberPoolId` to the campaign update Zod schema in T02's campaign routes
(a minor amendment, not a full T02 re-implementation).

---

## 10. RBAC

### 10.1 New Verbs

Add to `shared/types/src/rbac.ts` VERBS array:
```typescript
  // number pool (X04)
  'number_pool:read',
  'number_pool:edit',
```

Add `number_pool:edit` to `SENSITIVE_VERBS` (quarantine is a data-affecting action).

### 10.2 Role Matrix Additions

| Role        | number_pool:read | number_pool:edit |
|-------------|-----------------|------------------|
| super_admin | tenant          | tenant           |
| admin       | tenant          | tenant           |
| supervisor  | tenant          | —                |
| agent       | —               | —                |
| viewer      | tenant          | —                |
| integrator  | —               | —                |

`number_pool:edit` is **not** added to SENSITIVE_VERBS (it is an operational config action,
not a data-destructive action like `list:purge`). Quarantine is audited but not sensitive-flagged.

---

## 11. Audit Events

All events are emitted via the existing `audit()` helper in `api/src/auth/audit.ts`.

| Action                          | entityType       | entityId    | trigger                         |
|---------------------------------|-----------------|-------------|----------------------------------|
| `number_pool.created`           | `number_pool`   | pool.id     | POST /number-pools               |
| `number_pool.updated`           | `number_pool`   | pool.id     | PATCH /number-pools/:id          |
| `number_pool.deleted`           | `number_pool`   | pool.id     | DELETE /number-pools/:id         |
| `number_pool.did.added`         | `number_pool`   | pool.id     | POST /number-pools/:id/dids      |
| `number_pool.did.removed`       | `number_pool`   | pool.id     | DELETE /number-pools/:id/dids/:did |
| `number_pool.did.quarantined`   | `number_pool`   | pool.id     | manual or reaper                 |
| `number_pool.did.unquarantined` | `number_pool`   | pool.id     | POST .../unquarantine            |

Reaper-sourced quarantine events use `actorKind: 'system'` and `actorUserId: 0`.

---

## 12. Prometheus Metrics

### 12.1 Dialer (Go) — `dialer/internal/pool/metrics.go`

```go
var (
  poolPickTotal = promauto.NewCounterVec(prometheus.CounterOpts{
      Name: "vici2_pool_pick_total",
      Help: "Total number of pool picks by pool and strategy.",
  }, []string{"pool_id", "strategy"})

  poolPickEmpty = promauto.NewCounterVec(prometheus.CounterOpts{
      Name: "vici2_pool_pick_empty_total",
      Help: "Pool picks that returned ErrPoolEmpty (no eligible member).",
  }, []string{"pool_id"})

  poolCacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
      Name: "vici2_pool_cache_hits_total",
      Help: "Pool member cache hits.",
  }, []string{"pool_id"})

  poolCacheReloads = promauto.NewCounterVec(prometheus.CounterOpts{
      Name: "vici2_pool_cache_reloads_total",
      Help: "Pool member cache reloads triggered by invalidation or TTL.",
  }, []string{"pool_id"})
)
```

### 12.2 Workers (TypeScript) — `workers/src/jobs/number-pool-reaper/metrics.ts`

```typescript
export const reaperQuarantined = new Counter({
  name: 'vici2_pool_reaper_quarantined_total',
  help: 'DIDs auto-quarantined by the pool reaper.',
});
export const reaperRun = new Counter({
  name: 'vici2_pool_reaper_run_total',
  help: 'Pool reaper job executions.',
});
export const reaperBelowMin = new Gauge({
  name: 'vici2_pool_below_min_size',
  help: 'Number of pools below their min_active_size threshold.',
});
```

---

## 13. Testing Plan

### 13.1 Unit Tests

**`dialer/internal/pool/picker_test.go`**:
- TestPickHealthWeightedLRU_prefers_high_health
- TestPickHealthWeightedLRU_excludes_quarantined
- TestPickHealthWeightedLRU_excludes_cap_exceeded
- TestPickHealthWeightedLRU_area_code_filter
- TestPickRoundRobin_uniform_distribution
- TestPickRandom_no_panic_on_single_member
- TestPickFromPool_empty_returns_error
- TestRelease_decrements_counter

**`api/test/number-pool/service.test.ts`**:
- createPool — happy path, duplicate name conflict
- addDidToPool — DID from different tenant rejected
- quarantineDid — sets quarantine fields, emits audit
- unquarantineDid — clears quarantine fields, emits audit
- deletePool — blocked if campaign references it

**`workers/src/jobs/number-pool-reaper/reaper.test.ts`**:
- Quarantines member below AR floor with sufficient sample
- Does NOT quarantine member with insufficient sample
- Updates health score without quarantining
- Emits alert when pool drops below min size

### 13.2 Integration / Acceptance Tests

1. Pool of 10 DIDs assigned to campaign; 100 outbound calls all receive different CIDs in
   roughly uniform distribution (chi-square test, p > 0.05 with health_weighted_lru).
2. DID with answer_rate < 5% over 200+ calls is quarantined by reaper.
3. After manual unquarantine, DID immediately eligible for selection.
4. Per-DID stats visible via API with correct call counts.
5. Campaign with no pool falls through to campaign default CID (Tier 4).
6. Pool with all members quarantined returns ErrPoolEmpty → Tier 4 CID used.
7. Daily cap: after 200 picks, DID excluded from selection until next UTC day.

---

## 14. Phase Plan

### Phase 1 — Schema + Migration (0.5d)
- Write `20260513300000_x04_number_pools/migration.sql`.
- Add `NumberPool`, `NumberPoolDid` models to `schema.prisma`.
- Add `numberPoolId` to `Campaign` model.
- Run `prisma generate`.

### Phase 2 — API Layer (1.5d)
- `api/src/routes/admin/number-pools/schema.ts` — Zod validators.
- `api/src/routes/admin/number-pools/service.ts` — pool CRUD.
- `api/src/routes/admin/number-pools/did-service.ts` — DID membership + quarantine.
- `api/src/routes/admin/number-pools/stats-service.ts` — stats aggregation.
- `api/src/routes/admin/number-pools/index.ts` — route registration.
- Register routes in main app bootstrap.
- Unit tests.

### Phase 3 — RBAC + Audit (0.25d)
- Add `number_pool:read`, `number_pool:edit` to `shared/types/src/rbac.ts`.
- Update role matrix.
- Run `make gen-rbac` to regenerate `matrix_gen.go`.

### Phase 4 — Go Pool Picker (1d)
- `dialer/internal/pool/types.go`
- `dialer/internal/pool/picker.go`
- `dialer/internal/pool/cache.go`
- `dialer/internal/pool/metrics.go`
- `dialer/internal/valkey/keys.go` — add pool + DID key methods.
- Modify `dialer/internal/originate/cid_picker.go` — wire Tier 3.
- Modify `dialer/internal/originate/request.go` — add `NumberPoolID`, `LocalPresenceAreaCode`.
- Modify `dialer/internal/originate/chanvars.go` — add `vici2_pool_npid` channel var.
- `dialer/internal/pool/picker_test.go`.

### Phase 5 — Workers Reaper (0.5d)
- `workers/src/jobs/number-pool-reaper/reaper.ts`
- `workers/src/jobs/number-pool-reaper/metrics.ts`
- `workers/src/jobs/number-pool-reaper/index.ts`
- Wire into FreeSWITCH event router for call outcome recording.
- Register 1h cron in `workers/src/index.ts`.

### Phase 6 — Admin UI (0.75d)
- Pool list, detail, create, edit pages in `web/src/app/(admin)/number-pools/`.
- Campaign edit page pool selector amendment.

### Phase 7 — Integration Tests + Polish (0.5d)
- End-to-end acceptance tests.
- Prometheus alerts (pool_empty rate > 10% → alert).
- Documentation of X05 interface.

---

## 15. LOC Estimate

| Component                                      | Lines |
|------------------------------------------------|-------|
| Migration SQL                                  |  70   |
| Prisma schema amendments                       |  50   |
| API schema.ts                                  |  80   |
| API service.ts + did-service.ts + stats-service.ts | 280 |
| API index.ts (routes)                          |  80   |
| RBAC amendments                                |  30   |
| Go pool/types.go                               |  50   |
| Go pool/picker.go                              | 130   |
| Go pool/cache.go                               |  80   |
| Go pool/metrics.go                             |  30   |
| Go valkey/keys.go additions                    |  25   |
| Go originate/cid_picker.go amendment          |  40   |
| Go originate/request.go amendment              |  10   |
| Go originate/chanvars.go amendment             |  10   |
| Workers reaper.ts + index.ts + metrics.ts      | 160   |
| Workers event-router amendment                 |  50   |
| UI pages (4 files)                             | 200   |
| Unit + integration tests                       | 200   |
| **Total**                                      | **1,575** |

Target: ~1,400 lines (UI estimate assumes reuse of existing table + form components from D07).

---

## 16. Risk Register

| Risk                                           | Probability | Severity | Mitigation                                           |
|------------------------------------------------|-------------|----------|------------------------------------------------------|
| Pool cache staleness causes stale exclusion    | Medium      | Low      | 5-min backstop TTL + pub/sub invalidation            |
| ErrPoolEmpty during high quarantine period     | Medium      | Medium   | Fall through to Tier 4; emit metric; alert ops       |
| Valkey daily counter missed on crash           | Low         | Low      | At-most-once semantics acceptable; counter is soft   |
| Small pool (< 3 DIDs) concentrates reputation | High        | Medium   | Warn in UI; min_active_size alert via O03            |
| Reaper misses a burst-labeled number           | Medium      | High     | 1h max lag; X07 adds real-time label detection feed  |
| Cross-pod race in round-robin cursor           | Low         | Low      | Valkey INCR is atomic; no locking required           |

---

## 17. X05 Interface Contract

X04 exposes the following contract for X05 (local-presence):

```go
// PickFromPool with AreaCodeHint filters members to only those with
// matching area_code before applying the strategy. If no member matches
// the area code, PickFromPool returns ErrPoolEmpty (X05 falls back to
// any-number selection or campaign default).
PickFromPool(ctx context.Context, req pool.PickRequest) (*pool.PickResult, error)
```

X05 sets `req.AreaCodeHint` to the 3-digit area code of the destination number (derived from
`destE164[2:5]` for US +1NXXNXXXXXX format). X04 does no area-code derivation itself; it only
applies the filter if the hint is non-empty.

The `area_code CHAR(3)` column on `number_pool_dids` is indexed (`idx_npd_area_code`) so the
DB query that refreshes the cache can efficiently pre-filter. The in-process cache stores all
members (including area code) so the filter is applied in-process on every pick without a DB query.
