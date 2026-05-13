# Module D05 — DNC Management — PLAN

| Field | Value |
|---|---|
| Module | D05 (DNC scrub: Federal + State + Internal + Litigator) |
| Phase | 1 (Federal infrastructure + Internal); Phase 2 (Litigator + state productionize); Phase 4 (RND) |
| Compliance class | **Hard floor** (SPEC §4.1 — never bypassed without `dnc:bypass` super-admin override) |
| Status | PLAN (PROPOSED — awaiting orchestrator/human review) |
| Date | 2026-05-06 |
| Author | D05-PLAN sub-agent (Claude Opus 4.7, 1M ctx) |
| Companion | [RESEARCH.md](./RESEARCH.md) — 30 citations |
| Depends on (FROZEN) | F02 (`dnc` table), F04 (Valkey + Bloom), F05 (RBAC), C03 (audit chain) |
| Blocks | E01 (hopper filler — DNC gate), T04 (originate defense-in-depth), C04 (5-yr retention), M06 (admin DNC UI), O01 (alerts), O02 (Bloom backup) |

This plan turns the D05 spec + RESEARCH findings into the exact lookup
architecture, sync workers, API surface, override flow, code structure,
metrics, and test strategy that IMPLEMENT will deliver. Once approved,
the public surface (key shapes, REST endpoints, Bloom topology, audit
event names) is FROZEN.

---

## 0. TL;DR (10-bullet decision summary)

1. **F02 `dnc` table is sole source of truth.** PK
   `(tenant_id, phone_e164, source, state, campaign_id)` with sentinels
   `__` (state) and `__GLOBAL__` (campaign_id) is unchanged. Federal +
   litigator rows live under sentinel `tenant_id=0`; state rows also
   under `tenant_id=0` (public-license lists shared). Tenant-internal
   rows under that tenant's id.
2. **`valkey-bloom` module (Valkey 8 native, BSD-3) is the negative
   fast-path.** Four Bloom keys: `bf:dnc:federal` (global, ~540 MB at
   0.001 FPR for 250 M items), `t:{tid}:dnc:internal:bloom`
   (per-tenant, ~200 K cap), `t:{tid}:dnc:state:bloom` (per-tenant
   aggregate ~5 M cap), `bf:dnc:litigator` (Phase 2, ~10 M cap). All
   reserved with `EXPANSION 2`.
3. **Lookup hot path: Bloom MEXISTS pipeline first → MySQL confirm only
   on positive.** Target p99 < 5 ms, hard cap 10 ms. Federal lives in
   Go memory in the dialer process via direct Valkey calls (no API
   round-trip for hopper/originate gates).
4. **Fail-closed:** if Bloom unavailable (module not loaded, Valkey
   unreachable, key missing post-restore) → dialer **refuses to dial**
   for affected source. Compliance hard-floor invariant (SPEC §4.1).
   Operator alarm (`vici2_dnc_bloom_unavailable`).
5. **Federal sync = nightly delta + monthly full.** SOAP client wraps
   `DownloadSvc.asmx` (`CanGetChangeFile` → `GetChangeFile`); cron
   03:00 UTC; one-shot Valkey lock (60 min) prevents concurrent
   sessions per SAN. Phase 1 ships infrastructure + dummy seed; live
   subscription is an operator decision (recommend ship + flag).
6. **State sync (Phase 1 stub, Phase 2 productionize).** Worker
   scaffold ships; only TX/FL/TN/IN/PA actually pulled. TN monthly,
   others quarterly. Per-state cadence configured in `dnc_sync_config`
   table.
7. **Internal DNC = agent dispo + bulk import.** D04 dispo handler
   POSTs to `/api/dnc`; D02 (lead import) uses `/api/dnc/bulk`
   (max 5000 per call, csv-parse streaming). 5-year retention managed
   by C04 retention worker reading `added_at + INTERVAL 5 YEAR`.
8. **`dnc:bypass` is super-admin-only, single-use, Valkey-locked,
   justification-required, audit-paged.** Token TTL 300 s, redeemed
   atomically via Lua. Every grant fires `auth.dnc.bypass.granted`
   audit event at severity **page** (O01 PagerDuty alert on >0/min).
9. **Bloom DR = nightly `BF.SCANDUMP` per-key to S3.** Restore via
   `BF.LOADCHUNK` on bootstrap; falls back to rebuild from MySQL via
   streaming `BF.MADD` if S3 unavailable. Federal rebuild ~5 min wall
   time at 100K-batch chunks.
10. **Code split: `api/src/dnc/` (handlers, sync workers, bulk import,
    bypass) + `dialer/internal/dnc/` (in-process Check primitive that
    E01 and T04 import).** Shared zod schemas in
    `shared/types/src/dnc.ts`. No round-trips on hot path; both call
    Valkey + MySQL directly.

---

## 1. Sources & lookup architecture

### 1.1 Source inventory (FROZEN per F02 enum)

```
source ∈ { federal, state, internal, litigator, reassigned }
```

- **federal** — FTC National DNC. Stored under `tenant_id=0`, `state='__'`,
  `campaign_id='__GLOBAL__'`. Authoritative copy ~258 M rows.
- **state** — 11 active state DNCs. Stored under `tenant_id=0`,
  `state=<S>`, `campaign_id='__GLOBAL__'`. Phase 1: TX/FL/TN/IN/PA
  productionized; the other 6 (CO/LA/MA/MO/OK/WY) ship infrastructure
  only.
- **internal** — Per-tenant opt-outs (47 CFR 64.1200(d)). Stored under
  the tenant's actual id. Two sub-shapes:
  - Tenant-wide: `state='__'`, `campaign_id='__GLOBAL__'`
  - Campaign-scoped: `state='__'`, `campaign_id=<cid>` (Vicidial's
    `vicidial_campaign_dnc` collapsed into the same table)
- **litigator** — Phase 2. Vendor sync (Blacklist Alliance recommended)
  under `tenant_id=0`, `state='__'`, `campaign_id='__GLOBAL__'`.
- **reassigned** — Phase 4 (FCC RND). Per-call paid query; **does not
  populate the `dnc` table**. Positive RND result causes a row to be
  written under `source='internal'`, `notes='RND-reassigned'` (so the
  hot path catches it on subsequent dials).

### 1.2 Bloom filter topology (FROZEN)

All four Bloom keys reserved at module bootstrap if absent. `EXPANSION 2`
chains a doubled sub-filter on overflow (vs `NONSCALING` which errors).

| Key | Scope | Capacity (initial) | FPR | RAM (full) |
|---|---|---:|---:|---:|
| `bf:dnc:federal` | global (cross-tenant) | 300 000 000 | 0.001 | ~540 MB |
| `t:{tid}:dnc:internal:bloom` | per-tenant | 200 000 | 0.001 | ~360 KB |
| `t:{tid}:dnc:state:bloom` | per-tenant aggregate of state DNCs | 5 000 000 | 0.001 | ~9 MB |
| `bf:dnc:litigator` | global (Phase 2) | 10 000 000 | 0.001 | ~18 MB |

**Key naming rules:**
- Global Bloom keys use `bf:dnc:<source>` prefix (no tenant prefix —
  these are cross-tenant facts).
- Per-tenant Bloom keys use F04's `t:{tid}:dnc:<source>:bloom` shape.
- **No `{...}` cluster hash tag** — Bloom keys are large, won't be
  multi-key-Lua'd, and we want them spread across cluster shards.

**Reserve commands (idempotent at boot):**
```
BF.RESERVE bf:dnc:federal             0.001 300000000 EXPANSION 2
BF.RESERVE bf:dnc:litigator           0.001  10000000 EXPANSION 2     # Phase 2
BF.RESERVE t:{tid}:dnc:internal:bloom 0.001    200000 EXPANSION 2     # per-tenant on tenant create
BF.RESERVE t:{tid}:dnc:state:bloom    0.001   5000000 EXPANSION 2     # per-tenant on tenant create
```

Failure mode: if `BF.RESERVE` returns `BUSYKEY ERR item exists`, that's
the expected idempotent path — ignore.

### 1.3 Tenancy model (FROZEN)

- Federal, state, litigator → `tenant_id=0` sentinel row in `dnc`.
- Internal → real tenant_id.
- Bloom: federal/litigator are global (one Bloom shared by all
  tenants); state is **per-tenant aggregate** (memory-cheap; the
  positive-confirm MySQL query filters by tenant's permitted state set).
- F02 amendment ticket (non-controversial): allow `tenant_id=0` row in
  `dnc` (FK relaxation). Coordinated with F02 via HANDOFF.

### 1.4 Why per-tenant state Bloom (not per-state)

A 50-state-fanout per tenant explodes memory. Single per-tenant
aggregate keeps RAM bounded; positive Bloom hit forces MySQL confirm
that filters `state IN (S, '__')` for the lead's derived state.
Trade-off accepted: a CA lead positively-Bloom-hit by a TX-DNC entry
takes one extra MySQL round-trip (~1 ms) to discover it's not actually
DNC for CA — well within p99 budget.

### 1.5 Failure modes (FROZEN)

| Mode | Detection | Response |
|---|---|---|
| `valkey-bloom` module not loaded | `BF.RESERVE` returns ERR | **Fall back to in-process `bits-and-blooms/bloom/v3`** populated from MySQL on dialer boot. Emit `vici2_dnc_bloom_inprocess_active{source}=1`. Cost: ~540 MB RAM per dialer pod for federal; ~30-60 s startup. Acceptable for dev; alarm in prod. |
| Valkey unreachable | redis client error | **Fail-closed for that source.** Hopper filler emits `vici2_dnc_check_failed_total{source}` and skips lead (treats as DNC). T04 originate gate refuses dial. |
| Bloom key missing after restart | `BF.EXISTS` returns key-not-found | Restore from S3 via `BF.LOADCHUNK`; if S3 fails, rebuild from MySQL via streaming `BF.MADD`. Until rebuild completes, dialer pauses for affected source (`vici2_dnc_bloom_rebuilding=1`). |
| MySQL unreachable on positive Bloom hit | DB error | **Fail-closed.** Treat as DNC. Better to skip a few real leads than dial an opted-out number. |
| valkey-bloom returns malformed reply | parse error | Log + treat as fail-closed for that lead; alarm. |

---

## 2. Lookup flow (E01 hopper filler integration)

### 2.1 Hot-path algorithm (FROZEN)

```
Check(ctx, req CheckRequest) → CheckResult

CheckRequest {
  PhoneE164      string   // already normalized by caller (libphonenumber)
  TenantID       int64
  CampaignID     string   // "" if not campaign-scoped
  LeadState      string   // CHAR(2) or "" if unknown — used for state matching
  Sources        []string // {"federal","state","internal","litigator"} — campaign config
}

CheckResult {
  IsDNC          bool
  Sources        []string  // which source(s) matched
  LatencyMicros  int64     // for histogram
  BloomFalsePositive bool   // if Bloom said maybe but MySQL confirmed not
}
```

**Algorithm:**

```
1. Normalize phone (caller's responsibility; we re-validate format)
   → if invalid, return IsDNC=true with source="malformed" (fail-closed)

2. Build Bloom MEXISTS pipeline:
   keys = []
   if "internal"  in Sources:  keys += [t:{tid}:dnc:internal:bloom, phone]
   if "state"     in Sources:  keys += [t:{tid}:dnc:state:bloom,    phone]
   if "federal"   in Sources:  keys += [bf:dnc:federal,             phone]
   if "litigator" in Sources:  keys += [bf:dnc:litigator,           phone]   # Phase 2
   results = redis.BF.MEXISTS pipelined per key (one network round-trip)

3. If all results == 0 (negative): return IsDNC=false  ← typical case

4. For each Bloom-positive source, run MySQL confirmation:
   SELECT source, state, campaign_id
   FROM dnc
   WHERE phone_e164 = ?
     AND tenant_id  IN (?, 0)                      -- tenant + global federal/state/litigator
     AND source     IN (<positive-Bloom sources>)
     AND (
           source = 'federal'
        OR source = 'litigator'
        OR (source = 'internal' AND tenant_id = ?
              AND campaign_id IN ('__GLOBAL__', ?))
        OR (source = 'state'    AND tenant_id = 0
              AND state IN (?, '__'))
     )
     AND (expires_at IS NULL OR expires_at > NOW())
   LIMIT 4

5. If at least one row:
     return IsDNC=true, Sources=<distinct sources>
   Else:
     return IsDNC=false, BloomFalsePositive=true
     emit vici2_dnc_false_positive_total{source}
```

**Index used:** `idx_phone_only (phone_e164)` — F02 PLAN §4.14.
Covering for the hot-path. EXPLAIN: `ref` on the index, ≤4 rows
examined per check.

### 2.2 Latency budget

| Step | p99 |
|---|---:|
| Bloom MEXISTS pipeline (4 keys, 1 RTT, UDS) | 0.25 ms |
| MySQL confirm (only on positive) | 1.5 ms |
| Network + parse | 0.5 ms |
| **Total p99 hot path** | **~0.75 ms; ~2.25 ms with one positive** |

Comfortably under the 10 ms hard cap and the 5 ms soft target. Per
RESEARCH §4.1 math.

### 2.3 Source-priority resolution (audit reason)

When multiple sources match, `Result.Sources` is ordered by:
`internal > litigator > state > federal`. The first is "the" reason
recorded in audit (most specific to least). Per RESEARCH §10 Q9.

### 2.4 Caller integration contracts

- **E01 hopper filler:** calls `dnc.Check(ctx, req)` as Stage 4 of the
  per-lead gate pipeline (E01 RESEARCH §4.1 Stage 4). Order: cheaper
  than TZ check (one RTT vs 4-tier resolve), so TZ moves to Stage 5.
  **Coordinated with E01 PLAN: Stage order in E01 becomes
  state→DNC→TZ→TCPA, not state→TZ→DNC→TCPA.**
- **T04 originate gate:** final defense-in-depth check, ~50ms before
  `bgapi originate`. Cheap (sub-ms), catches edge cases (federal
  delta sync ran between hopper-fill and originate).
- **D04 dispo handler:** does NOT call Check; instead writes new DNC
  row when agent dispos `DNC` / `DNCC`.
- **D06 callback worker:** calls Check before scheduling immediate
  re-injection (E01 RESEARCH §9.2).

---

## 3. Federal DNC sync

### 3.1 SOAP client (FROZEN — workers/src/jobs/dnc-sync-federal/)

Phase 1 ships **infrastructure + dummy data**. Real subscription is an
operator decision; the sync worker can run in `DRY_RUN=true` mode that
loads `db/seeds/dnc-federal-test.csv` (10 000 sample rows) instead of
calling the FTC API. Recommendation to orchestrator: **ship
infrastructure**.

**Endpoint:** `https://telemarketing.donotcall.gov/DownloadSvc/DownloadSvc.asmx`

**Operations used (FROZEN per RESEARCH §3):**
- `LogIn(strSAN, strRepPwd, strCoID)` → returns `strSessionToken`
- `CanGetChangeFile(strSessionToken, strCoID)` → status code
- `GetChangeFile(strSessionToken, strCoID, strFormat='FlatText',
  strAreaCode='ALL')` → returns presigned URL
- `CanGetFullFile(...)` → status code (monthly path)
- `GetFullFile(...)` → presigned URL (monthly path)
- `LogOut(strSessionToken)` → cleanup

**Library:** `strong-soap` (Node) for WSDL-driven client gen, or
hand-rolled XML over `node-fetch` (~150 lines). Recommendation: hand-
rolled — the SOAP surface is tiny (5 ops), and `strong-soap` adds
~2 MB and unpredictable WSDL parsing.

**XML parse:** `fast-xml-parser` zod-validated against a documented
schema (`api/src/dnc/sync/federal-soap-schema.ts`). Per RESEARCH §14
mitigation.

### 3.2 Daily delta cron

Schedule: `0 3 * * *` (03:00 UTC, off-peak per FTC ops guidance).
Cron managed via F04 cron-registration helper.

```
Worker: dnc-sync-federal-delta
  1. Acquire Valkey lock: SET t:0:dnc:fed:sync:lock <pid> NX EX 3600
     If !lock: return (someone else's running)
  2. logIn() → sessionToken
  3. status = canGetChangeFile()
     - 'AlreadyDownloadedToday' → release lock, return success
     - 'NoChanges' → release lock, return success
     - 'RequestPending' → poll with 30s backoff up to 10 min, then abort
     - 'RequestCompleted' → proceed
  4. presignedUrl = getChangeFile(format='FlatText', areaCode='ALL')
  5. download zip → /tmp/dnc-fed-delta-{date}.zip
  6. unzip → fixed-width text file
  7. parse line-by-line:
       phone_10digit (10) + ' ' + date (YYYY-MM-DD) + ' ' + action (A|D)
  8. batch UPSERT/DELETE in 5000-row chunks via prisma.$transaction:
       'A': INSERT IGNORE INTO dnc (tenant_id=0, phone_e164='+1'+phone, source='federal', ...)
            BF.MADD bf:dnc:federal +1{phone} (batched 100k at a time)
       'D': UPDATE dnc SET expires_at=NOW() WHERE tenant_id=0 AND phone_e164=? AND source='federal'
            (Note: do NOT remove from Bloom — Bloom has no DEL semantics;
             expires_at handles correctness; monthly full reconcile rebuilds Bloom)
  9. logOut()
  10. INSERT INTO dnc_sync_log (source='federal', kind='delta', added, removed, started_at, completed_at, file_hash)
  11. audit: dnc.sync.federal at severity info; one summary row per sync (per RESEARCH §10 Q5)
  12. Release Valkey lock
```

**Failure handling:** any error → release lock + log + audit
`dnc.sync.federal.failed` at severity warn; cron retries on next
schedule. Three consecutive failures → severity page.

### 3.3 Monthly full reconcile

Schedule: `0 4 1 * *` (04:00 UTC, 1st of month).

```
Worker: dnc-sync-federal-full
  1. Acquire Valkey lock (same as delta)
  2. logIn(), canGetFullFile, getFullFile(format='FlatText', areaCode='ALL')
  3. download zip (potentially ~500 MB for full national)
  4. unzip → text file (one phone per line, per area code)
  5. Two-phase apply (online):
     a. Build new Bloom: BF.RESERVE bf:dnc:federal:new 0.001 300000000 EXPANSION 2
        Stream phones → BF.MADD in 100k chunks
     b. MySQL drop-and-rebuild federal partition:
        - Stream into a temp table (LOAD DATA LOCAL INFILE) ~10 min
        - In a single tx: DELETE FROM dnc WHERE source='federal' AND tenant_id=0
                          INSERT INTO dnc SELECT FROM temp
                          DROP TABLE temp
     c. Atomic Bloom swap:
        - RENAME bf:dnc:federal → bf:dnc:federal:old
        - RENAME bf:dnc:federal:new → bf:dnc:federal
        - DEL bf:dnc:federal:old
        (RENAME is atomic; readers see one or the other, never neither)
  6. INSERT INTO dnc_sync_log (kind='full')
  7. audit: dnc.sync.federal severity warn (full reconcile is rare/expensive)
  8. Release lock
```

**Why two-phase:** allows hot-path lookups to continue against the old
Bloom while the new one builds; the swap is sub-millisecond.

### 3.4 Cost monitoring

Metric: `vici2_dnc_federal_subscription_area_codes_gauge` (set from
config). Cost calc in HANDOFF (`area_codes × $82 + $200 setup`).
First 5 area codes free for trials. Full national = $22 626/yr in
FY2026.

---

## 4. State DNC sync

### 4.1 Per-state worker scaffold (Phase 1)

```
workers/src/jobs/dnc-sync-state/
  index.ts                   — dispatcher; reads dnc_sync_config rows
  state-pa.ts                — IMS Inc download (Phase 2 productionize; Phase 1 stub)
  state-tn.ts                — TPUC monthly cloud-share (Phase 2)
  state-fl.ts                — FL DACS quarterly (Phase 2)
  state-tx.ts                — Gryphon Networks quarterly (Phase 2)
  state-in.ts                — IN AG quarterly (Phase 2)
  state-{co,la,ma,mo,ok,wy}.ts — stubs only (Phase 3+)
```

### 4.2 `dnc_sync_config` table (NEW, F02 amendment)

```sql
CREATE TABLE dnc_sync_config (
  source      VARCHAR(32) NOT NULL,        -- 'federal' | 'state:TX' | 'litigator'
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  cadence     ENUM('daily','weekly','monthly','quarterly') NOT NULL,
  last_run_at DATETIME(6) NULL,
  next_run_at DATETIME(6) NULL,
  config_json JSON NULL,                    -- vendor URLs, credentials reference (KEK-encrypted)
  created_at, updated_at DATETIME(6),
  PRIMARY KEY (source)
);
```

Phase 1 seeds rows for federal + 11 state sources, all `enabled=false`
except federal (which can be flipped by operator after SAN purchase)
and the 5 productionized state PRs.

### 4.3 State sync flow (template)

Each state worker implements:
```
async run(): Promise<{ added: number; removed: number }>
```

Common flow (concrete per-state vendor differences in subdirs):
1. Acquire Valkey lock `t:0:dnc:state:{S}:sync:lock` 60 min TTL.
2. Download list per vendor protocol (HTTPS basic auth, SFTP, etc.).
3. Parse (CSV / fixed-width per vendor).
4. Diff against MySQL (`SELECT phone_e164 FROM dnc WHERE tenant_id=0
   AND source='state' AND state=?`).
5. Apply: INSERT new + UPDATE expires_at on removed.
6. **Per-tenant Bloom rebuild** (state Bloom is per-tenant aggregate):
   for each tenant with `use_state_dnc=TRUE`, rebuild
   `t:{tid}:dnc:state:bloom` from MySQL via `BF.MADD` chunks
   (the dialer reads after rebuild; reads during rebuild fall back to
   MySQL — alarm fires if rebuild > 5 min).
7. INSERT INTO dnc_sync_log.
8. audit: dnc.sync.state severity info.
9. Release lock.

---

## 5. Internal DNC

### 5.1 Sources of writes

- **Agent dispo `DNC` / `DNCC`** → D04 disposition handler POSTs to
  `/api/dnc` with `source='internal'`, `campaign_id='__GLOBAL__'`
  (or campaign_id of current call for `DNCC`).
- **Agent "Stop calling me about X" form** → A01 UI POST to `/api/dnc`
  with campaign-scoped `campaign_id`.
- **Bulk import** (D02 territory) → POST to `/api/dnc/bulk` (max 5000
  rows per call, csv-parse streaming).
- **Inbound IVR opt-out** → T04 IVR app calls internal HTTP endpoint
  → POST to `/api/dnc`.
- **Web-form opt-out** → public landing page (Phase 4 / N02) → POST
  to `/api/dnc`.
- **Super-admin manual add** → M06 admin DNC UI.

### 5.2 5-year retention (FCC 64.1200(d))

C04 retention worker reads:
```sql
SELECT id FROM dnc
WHERE source='internal'
  AND added_at < NOW() - INTERVAL retention_years YEAR
  AND tenant_id = ?
LIMIT 1000
```
where `retention_years` defaults to 5 (FCC floor) and is configurable
per-tenant (`tenants.internal_dnc_retention_years` SMALLINT DEFAULT 5;
F02 amendment, max 99). Per RESEARCH §10 Q8.

Soft-deletion: rows are removed from the `dnc` table AND the
per-tenant Bloom is rebuilt nightly (Bloom has no DEL; we accept the
rebuild cost). Audit row `dnc.retention.purged` at severity info per
batch (not per row — bulk-summary).

### 5.3 Honor window (10 business days)

The 10-business-day honor window is a **policy guarantee** — once an
internal DNC row exists, it is honored *immediately* (next dial). The
10-day window is the *legal maximum* between request and honor. We
honor the same second; no special handling needed.

---

## 6. API surface

### 6.1 Endpoints (FROZEN)

All routes mounted at `/api/dnc` (api package, Fastify). All require
`requireAuth` + `requireTenant`. Permission checks per F05 PLAN §6.2.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/dnc` | `dnc:read` | Lookup single phone (super-fast, hot-path-cached) |
| POST | `/api/dnc` | `dnc:edit` | Add single (internal) |
| POST | `/api/dnc/bulk` | `dnc:edit` | Bulk add (multipart CSV; max 5000 rows) |
| DELETE | `/api/dnc/:id` | `dnc:edit` (or `dnc:bypass` for federal/litigator) | Remove |
| POST | `/api/dnc/bypass` | `dnc:bypass` | Mint single-use bypass token |
| GET | `/api/dnc/audit` | `audit:view` | List `dnc.bypass.*` audit events |
| POST | `/api/dnc/sync/federal` | `dnc:edit` (super-admin in practice) | Trigger sync (button in UI) |
| GET | `/api/dnc/sync-status` | `dnc:read` | Last sync timestamps for all sources |

**Note:** the spec doc D05.md uses `/api/admin/dnc/*` paths. PLAN
flattens to `/api/dnc/*` for consistency with the rest of the API
(admin-only protection is via RBAC middleware, not URL prefix).
Coordinated with M06 (DNC admin UI consumer).

### 6.2 GET `/api/dnc?phone=<E164>`

```
Query: { phone: string (E.164), tenantId?: number, campaignId?: string }
Response: {
  isDnc: boolean,
  sources: ('federal'|'state'|'internal'|'litigator')[],
  details: [{ source, state, campaignId, addedAt, expiresAt, notes }]
}
```

Implementation: thin wrapper over `dnc.Check(...)` (same primitive the
dialer uses). p99 < 5 ms target.

### 6.3 POST `/api/dnc`

```
Body: {
  phone: string (E.164),
  source: 'internal',                    // only 'internal' accepted via API
  state?: string,                         // CHAR(2); default '__'
  campaignId?: string,                    // default '__GLOBAL__'
  notes?: string                          // up to 255
}
Response: { id: bigint, addedAt: ISO8601 }
```

Pipeline:
1. Validate (zod): phone matches E.164; source='internal'; state∈US|`__`.
2. Normalize phone via libphonenumber-js (re-validate even if caller did).
3. INSERT IGNORE INTO dnc (...) within tx.
4. BF.ADD t:{tid}:dnc:internal:bloom phone.
5. audit: `dnc.add` (in same tx; F05 audit() helper).
6. Return id.

### 6.4 POST `/api/dnc/bulk`

```
multipart/form-data:
  source: 'internal' | 'state' | 'litigator'    // 'internal' only outside super-admin
  state?: CHAR(2)                                 // required if source='state'
  campaignId?: string
  file: <CSV>                                     // max 5000 rows, max 5 MB
  notes?: string
Response: { added: number, rejected: number, jobId: string }
```

Pipeline (`workers/src/jobs/dnc-bulk-import/`):
1. Stream-parse CSV with `csv-parse` (Node) — chunk = 1000 rows.
2. Normalize each row via libphonenumber-js; reject malformed (counted).
3. Within a tx: `INSERT IGNORE INTO dnc (...) VALUES (...)` (1000-row batch).
4. After commit: batched `BF.MADD` against the Bloom key.
5. One `audit_log` row per chunk + summary row in `dnc_sync_log`
   (`kind='bulk'`).

Target throughput: 5000 rows in ≤ 10 s on a 4-core api pod.

### 6.5 DELETE `/api/dnc/:id`

- Requires `dnc:edit` for `internal`/`state`.
- Requires `dnc:bypass` (super-admin) for `federal`/`litigator` AND
  honors a hold-period (federal entries cannot be removed until
  `expires_at` is set by FTC sync — admin must wait for next delta).
- Does NOT remove from Bloom (no DEL semantics); marked
  `expires_at=NOW()` so hot-path treats as not-DNC.
- audit: `dnc.remove` severity warn; super-admin removals at severity
  page.

### 6.6 POST `/api/dnc/bypass` (super-admin override)

```
Body: {
  phone: string (E.164),
  source: 'internal' | 'state' | 'federal' | 'litigator',
  justification: string (10-500 chars, required),
  ttlSeconds?: number (default 60, max 300)
}
Response: { token: string, expiresAt: ISO8601 }
```

- Permission: `dnc:bypass` (super-admin only per F05).
- Token = base64url(32 random bytes); hash stored in Valkey.
- Valkey: `SET t:{tid}:dnc:bypass:{tokenHash} {phone}|{source}|{user_id}|{justification_hash} NX EX <ttl>`.
- audit: `dnc.bypass.granted` severity **page** (PagerDuty alert via O01).
- Token redeemed atomically by T04 originate gate (single-use):
  ```lua
  -- redeem_dnc_bypass.v1.lua
  local v = redis.call('GETDEL', KEYS[1])
  if not v then return nil end
  if v ~= ARGV[1] then  -- expected payload
    return 'MISMATCH'
  end
  return 'OK'
  ```
- audit: `dnc.bypass.consumed` severity warn on T04 redemption;
  `dnc.bypass.attempt` severity warn on every attempt (even denied).

**Legal use case (HANDOFF):** returning an inbound from a DNC-listed
customer is the only common-case legal bypass. Outbound bypass is
essentially never legal; the M06 UI shows a red banner saying so.

### 6.7 GET `/api/dnc/audit`

Returns `dnc.bypass.*` audit events filtered by tenant. Permission:
`audit:view` (super-admin per F05). Pagination 50/page.

---

## 7. `dnc:bypass` permission semantics

### 7.1 Permission matrix (FROZEN — F05 PLAN §6.2)

| Verb | Holders |
|---|---|
| `dnc:read` | admin, super_admin |
| `dnc:edit` | admin, super_admin |
| `dnc:bypass` | **super_admin only** |
| `audit:view` | **super_admin only** |

(Per F05 PLAN §6.2 — already specified, no F05 amendment needed.)

### 7.2 Bypass redemption flow (FROZEN)

```
1. Super-admin in M06 UI clicks "Bypass DNC for inbound return"
2. UI POSTs /api/dnc/bypass with {phone, source, justification}
3. API validates super-admin, mints token, audits 'dnc.bypass.granted'
4. UI displays token (one-time, never logged) + tells operator
   "Token valid for 5 minutes; use it on the next outbound to {phone}"
5. Super-admin clicks "Dial Now" — UI calls T04's manual originate
   endpoint with {phone, dncBypassToken: token}
6. T04 validates token via redeem_dnc_bypass.v1.lua atomically
7. If OK: skip dnc.Check; proceed to originate; audit 'dnc.bypass.consumed'
8. If MISMATCH/expired: return 403; audit 'dnc.bypass.attempt' severity warn
```

### 7.3 Audit invariants (FROZEN)

- Every grant attempt audits, even on permission denial
  (`dnc.bypass.denied` severity warn — F05 captures this via
  middleware-level rejection before reaching the handler).
- Every grant audits `dnc.bypass.granted` severity page.
- Every consumption (redemption by T04) audits
  `dnc.bypass.consumed` severity warn.
- Every failed redemption (mismatch, expired) audits
  `dnc.bypass.attempt` severity warn.
- C03 hash chain ensures audit immutability.

---

## 8. Sync cadence (FROZEN)

| Source | Cadence | Cron | Notes |
|---|---|---|---|
| **Federal delta** | Daily | `0 3 * * *` (03:00 UTC) | SOAP `GetChangeFile` |
| **Federal full** | Monthly | `0 4 1 * *` (04:00 UTC, 1st) | SOAP `GetFullFile` + Bloom rebuild |
| **State TN** | Monthly | `0 5 1 * *` (05:00 UTC, 1st) | TPUC cloud-share |
| **State FL/TX/IN/PA** | Quarterly | `0 6 1 1,4,7,10 *` (06:00 UTC, 1st of Jan/Apr/Jul/Oct) | Per-vendor |
| **State others** | Quarterly | (stub Phase 1) | Phase 3+ |
| **Litigator (Phase 2)** | Daily delta | `0 2 * * *` | Vendor API |
| **RND (Phase 4)** | Per-call | n/a | Paid-per-query |
| **Internal retention purge** | Daily | `0 7 * * *` (07:00 UTC) | C04 worker |
| **Bloom snapshot to S3** | Daily | `0 1 * * *` (01:00 UTC) | O02 backup |

All crons registered via F04 cron-helper; concurrent-run prevention via
per-source Valkey lock (60 min TTL).

---

## 9. Code structure

### 9.1 TypeScript (api / workers)

```
api/src/dnc/
  index.ts                       — barrel export
  check.ts                       — high-level Check() wrapper (calls dialer-style hot path)
  bloom.ts                       — BF.RESERVE/MADD/MEXISTS wrappers + fallback to in-process
  bloom-fallback.ts              — bits-and-blooms-style in-process Bloom (port via Wasm or pure JS)
  bypass.ts                      — bypass token mint/redeem helpers
  sync/
    federal-soap-client.ts       — typed SOAP client (5 ops)
    federal-soap-schema.ts       — zod XML schema
    federal-sync-delta.ts        — daily worker
    federal-sync-full.ts         — monthly worker
    state-sync.ts                — dispatcher
    state-pa.ts ... state-wy.ts  — per-state implementations (stubs in Phase 1 except top-5)
    litigator-sync.ts            — Phase 2 stub
  bulk-import.ts                 — CSV streaming import

api/src/dnc/lua/
  redeem_dnc_bypass.v1.lua       — atomic GETDEL + payload validate

api/src/routes/dnc/
  get-check.ts                   — GET /api/dnc?phone=
  post-add.ts                    — POST /api/dnc
  post-bulk.ts                   — POST /api/dnc/bulk
  delete-id.ts                   — DELETE /api/dnc/:id
  post-bypass.ts                 — POST /api/dnc/bypass
  get-audit.ts                   — GET /api/dnc/audit
  post-sync-federal.ts           — POST /api/dnc/sync/federal
  get-sync-status.ts             — GET /api/dnc/sync-status

workers/src/jobs/
  dnc-sync-federal-delta/index.ts
  dnc-sync-federal-full/index.ts
  dnc-sync-state/index.ts
  dnc-bulk-import/index.ts
  dnc-bloom-snapshot/index.ts    — nightly BF.SCANDUMP → S3
  dnc-bloom-restore/index.ts     — bootstrap BF.LOADCHUNK from S3

api/test/dnc/
  check.test.ts
  bloom.test.ts                  — module load + fallback
  bypass.test.ts                 — redeem-once semantic
  sync/federal.test.ts           — mocked SOAP
  sync/state.test.ts
  bulk-import.test.ts
  routes/*.test.ts
```

### 9.2 Go (dialer)

In-process check primitive used by E01 hopper filler + T04 originate
gate. Talks to Valkey + MySQL directly (no API round-trip on hot path).

```
dialer/internal/dnc/
  check.go                       — Check(ctx, req) → CheckResult
  bloom.go                       — BF.MEXISTS pipeline wrapper + circuit breaker
  bloom_fallback.go              — github.com/bits-and-blooms/bloom/v3 in-process
  mysql.go                       — confirmation query
  bypass.go                      — token redemption helper for T04
  metrics.go                     — Prometheus counters/histograms
  types.go                       — CheckRequest, CheckResult, Source enum
  check_test.go
  bloom_test.go
  integration_test.go            — testcontainers Valkey + MySQL
```

### 9.3 Shared

```
shared/types/src/dnc.ts          — Source enum, CheckRequest, CheckResult zod schemas
shared/lua/redeem_dnc_bypass.v1.lua  — copy of api Lua (single source of truth here;
                                       both api and dialer import via fs.readFileSync at boot)
```

---

## 10. Bloom backup / restore (DR)

### 10.1 Nightly snapshot (FROZEN)

Worker `dnc-bloom-snapshot` (cron `0 1 * * *`):

```
For each Bloom key in {bf:dnc:federal, bf:dnc:litigator,
                       t:{tid}:dnc:internal:bloom (per-tenant),
                       t:{tid}:dnc:state:bloom (per-tenant)}:
  iter = 0
  while true:
    (next, chunk) = BF.SCANDUMP key iter
    if next == 0: break
    s3.putObject(
      bucket='vici2-backups',
      key=`bloom/{date}/{key-safe}.{iter}.bin`,
      body=chunk
    )
    iter = next
```

S3 lifecycle: 7 daily, 4 weekly, 12 monthly. SSE-KMS at rest.

### 10.2 Restore on bootstrap

Worker `dnc-bloom-restore` (called by api/dialer on startup if Bloom
key missing):

```
1. List S3 prefix bloom/{latest-date}/{key-safe}.*.bin sorted by iter
2. For each chunk:
   BF.LOADCHUNK key iter chunk-bytes
3. Verify BF.INFO key matches expected size
4. If S3 unavailable or verify fails:
   Fall back to rebuild from MySQL:
     SELECT phone_e164 FROM dnc WHERE source=? [AND tenant_id=?] [AND state=?]
     stream → BF.MADD chunks of 100k
     log + alarm vici2_dnc_bloom_rebuilt_from_mysql_total{source}
```

### 10.3 Until-restore behavior

While Bloom is rebuilding, hot-path calls to `Check()` for the
affected source **fall back to MySQL-only**. p99 jumps from 0.75 ms
to ~5-10 ms for federal (worst case). Alarm fires; operator
decides whether to pause the dialer (`vici2_dnc_bloom_rebuilding=1`
in O01).

---

## 11. Metrics (O01 contract)

### 11.1 Counters / histograms (FROZEN names)

```
vici2_dnc_check_total{source,outcome}              counter
  source ∈ {federal, state, internal, litigator}
  outcome ∈ {hit, miss, false_positive, error, fail_closed}

vici2_dnc_check_latency_seconds{source}            histogram
  buckets: [.0005, .001, .002, .005, .01, .025, .05, .1]

vici2_dnc_bypass_total{user_role,outcome}          counter
  outcome ∈ {granted, denied, consumed, expired, mismatch}
  ALERT (O01 PAGE): rate > 0/min sustained 5 min

vici2_dnc_sync_last_success_timestamp{source}      gauge
  ALERT (O01 WARN): now - value > 36h for federal delta

vici2_dnc_sync_failures_total{source,kind}         counter
  kind ∈ {delta, full, state, litigator}
  ALERT (O01 WARN): rate > 0 for 3 consecutive runs

vici2_dnc_bloom_size{key}                          gauge
  via BF.INFO

vici2_dnc_false_positive_total{source}             counter
  ALERT (O01 INFO): ratio > 0.002 (2× configured FPR) sustained 1h

vici2_dnc_bloom_unavailable{source}                gauge (0|1)
  ALERT (O01 PAGE): == 1

vici2_dnc_bloom_inprocess_active{source}           gauge (0|1)
  ALERT (O01 WARN): == 1 in production env

vici2_dnc_bloom_rebuilding{source}                 gauge (0|1)
  ALERT (O01 WARN): == 1 sustained > 10 min

vici2_dnc_federal_subscription_area_codes_gauge    gauge
  (informational; for cost dashboard)
```

### 11.2 Audit events emitted (FROZEN)

| event | severity | when |
|---|---|---|
| `dnc.add` | info | single add |
| `dnc.bulk_import` | info | bulk import (one summary row per chunk) |
| `dnc.remove` | warn | single remove |
| `dnc.remove.federal` | **page** | federal/litigator removal (super-admin) |
| `dnc.bypass.granted` | **page** | super-admin minted bypass token |
| `dnc.bypass.consumed` | warn | token redeemed by T04 |
| `dnc.bypass.attempt` | warn | every attempt (denied, expired, mismatch) |
| `dnc.bypass.denied` | warn | RBAC denied at middleware (no token issued) |
| `dnc.sync.federal` | info | summary per delta sync |
| `dnc.sync.federal.full` | warn | monthly full reconcile (rare/expensive) |
| `dnc.sync.federal.failed` | warn (page on 3 consecutive) | sync error |
| `dnc.sync.state` | info | summary per state sync |
| `dnc.sync.state.failed` | warn | sync error |
| `dnc.retention.purged` | info | C04 batch purge (one row per batch, not per record) |

---

## 12. Hand-off interfaces

### 12.1 To E01 (hopper filler)

- Import `dialer/internal/dnc.Check(ctx, req)`.
- Integrate as **Stage 4 of E01 gate pipeline**, BEFORE TZ check
  (cheaper: 1 RTT vs 4-tier in-memory resolve, but more selective —
  most leads pass, so order doesn't matter much, but DNC is more
  likely to fail-fast on bad data).
- E01 RESEARCH §4.1 already lists DNC as Stage 4. **PLAN coordination
  with E01: keep order state→DNC→TZ→TCPA per E01 RESEARCH.**
- Skip-reason metric: E01 emits `vici2_dialer_filler_skipped_total{reason="dnc_federal"|"dnc_state"|"dnc_internal"|"dnc_litigator"}`.

### 12.2 To T04 (originate path)

- Import `dialer/internal/dnc.Check(ctx, req)` for final
  defense-in-depth check ~50 ms before `bgapi originate`.
- Import `dialer/internal/dnc.RedeemBypass(ctx, token, phone, source)`
  for super-admin manual override path.
- audit: `dnc.bypass.consumed` on successful redeem.

### 12.3 To F02

- F02 amendments (non-breaking; coordinated via HANDOFF):
  1. Allow `tenant_id=0` row in `dnc` (sentinel for global federal/state/litigator).
  2. New table `dnc_sync_config` (per §4.2).
  3. New table `dnc_sync_log` (per RESEARCH §3.2).
  4. New `tenants.internal_dnc_retention_years SMALLINT NOT NULL DEFAULT 5`.

  None of these break existing F02 PLAN; ship as additive migration
  `20260507_dnc_sync_config_and_retention/`.

### 12.4 To C04 (retention worker)

- C04 picks up `dnc_internal_retention_purge` job per §5.2.
- C04 MUST audit `dnc.retention.purged` per batch.
- C04 schedules nightly Bloom rebuild after purge if rows were
  deleted (per-tenant `t:{tid}:dnc:internal:bloom`).

### 12.5 To O01 (alerting)

- All metrics/alerts per §11.
- New PagerDuty service `vici2-dnc-bypass` (page-severity events).
- New PagerDuty service `vici2-dnc-bloom` (bloom-unavailable events).

### 12.6 To O02 (backup)

- Nightly S3 snapshot of all Bloom keys per §10.1.
- O02 includes Bloom snapshots in its retention policy (7d/4w/12m).

### 12.7 To M06 (DNC admin UI)

- Consumes API surface §6.
- UI must display red banner on bypass form: "Outbound DNC bypass is
  essentially never legal. Use only for returning inbound calls."
- UI must require justification text (10-500 chars).
- Audit-log viewer reads from `/api/dnc/audit`.

### 12.8 To D02 (lead import)

- D02 calls `/api/dnc/bulk` for any bulk-CSV uploads where the import
  list is also a DNC source (rare). Standard path: D02 imports leads
  to `leads` table; D05 doesn't see them.

### 12.9 To D04 (disposition handler)

- D04 calls `POST /api/dnc` when agent dispos `DNC` or `DNCC`:
  - `DNC` → tenant-wide internal (campaign_id='__GLOBAL__')
  - `DNCC` → campaign-scoped (campaign_id=current campaign)

### 12.10 To D06 (callback worker)

- D06 calls `dialer/internal/dnc.Check(...)` before `ScheduleImmediate`
  (per E01 RESEARCH §9.2). If DNC-late-add, callback is dropped with
  audit `dnc.callback.suppressed` severity info.

---

## 13. Open questions (RESOLVED)

All RESEARCH §10 questions resolved by this PLAN:

| Q | Answer in PLAN |
|---|---|
| Q1 Federal-DNC tenancy | `tenant_id=0` sentinel; F02 amendment §12.3 |
| Q2 State-DNC tenancy | `tenant_id=0` sentinel (public-license lists shared) |
| Q3 RND productionization | Phase 4; consent-tracking table at that time |
| Q4 Litigator vendor | Recommend Blacklist Alliance (consolidation); Phase 2 |
| Q5 Audit-log explosion on sync | One summary row per source per day |
| Q6 Tenant-delete Bloom cleanup | `BF.DEL t:{tid}:*:bloom` pattern scan; cheap |
| Q7 Inbound DNC bypass UX | Agent click "Yes, returning their call" required; documented in UI |
| Q8 Internal retention beyond 5y | Per-tenant `internal_dnc_retention_years` (default 5, max 99) |
| Q9 Source-priority in audit | `internal > litigator > state > federal` |
| Q10 Bloom-FP metric alarm | `vici2_dnc_false_positive_total{source}`, alert ratio > 2× |

**One orchestrator decision deferred:** whether to ship federal-sync
infrastructure live in Phase 1 (recommended: ship + dummy data; live
SAN subscription is operator decision after Phase 1 validation).

---

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bloom false-positive rate > spec | Low | Low | 0.001 FPR + MySQL confirmation; alarm at 2× ratio (§11). |
| `valkey-bloom` module unavailable | Low | Medium | In-process `bits-and-blooms` fallback (§1.5). Acceptable in dev; alarm in prod. |
| Federal SOAP API rate-limit / outage | Medium | Low | Backoff + retry; daily delta tolerates 1-2 day skip; monthly full as backstop. Alarm if `now - last_success > 36h`. |
| SOAP XML parse brittleness | Medium | Medium | zod-validated schema; integration test suite with captured WSDL responses; fallback to manual operator-trigger via `POST /api/dnc/sync/federal`. |
| Federal full reconcile during business hours | Low | Medium | Two-phase apply with atomic Bloom RENAME; readers see one Bloom or the other, never neither. |
| Cleartext phone in `dnc` table | High by design | Low | RBAC + at-rest disk encryption; FCC inspection requires cleartext. |
| Cost surprise (federal subscription) | Medium | Low | `vici2_dnc_federal_subscription_area_codes_gauge` + monthly cost dashboard; HANDOFF documents pricing. |
| Bypass token replay | Low | High | Lua-atomic GETDEL ensures single-use; 5-min TTL ceiling; every attempt audits. |
| Bypass justification fakery | Medium (operator behavior) | Low | Justification audit-logged; quarterly compliance review of `dnc.bypass.granted` events. |
| Monthly Bloom rebuild memory spike | Low | Medium | Two-phase reserve uses temporary `:new` key; total RAM ~2× during swap (~1 GB transient for federal); Phase 1 box has 4 GB Valkey budget. |
| Per-tenant state Bloom rebuild slow on large tenant | Low | Medium | Background rebuild; reads fall back to MySQL during rebuild; alarm if > 5 min. |
| F02 `tenant_id=0` FK constraint blocks insert | Low | High | F02 amendment §12.3 must land BEFORE D05 IMPLEMENT. Coordinated at orchestrator level. |
| valkey-bloom not packaged in F04's Valkey image | Medium | High | F04 PLAN §4.12 already flags Bloom as future enhancement; D05 IMPLEMENT amends F04 docker image to include `valkey-bloom` module load (`loadmodule /opt/valkey-bloom.so` in valkey.conf). |

---

## 15. Acceptance criteria (from D05.md, restated against this PLAN)

- [ ] `dnc.Check` p99 < 5 ms; p99.9 < 10 ms (§2.2 budget; verified via integration bench).
- [ ] Federal sync stub loads `db/seeds/dnc-federal-test.csv` (10 000 rows) into both MySQL and `bf:dnc:federal` (§3 + dev mode).
- [ ] Lookup against seeded phone returns `{ isDnc:true, sources:['federal'] }`.
- [ ] Add internal opt-out → next lookup includes `internal` (Bloom + MySQL both updated).
- [ ] Remove internal entry → no longer DNC (Bloom unchanged but MySQL `expires_at` set).
- [ ] Bulk add 5000 entries via CSV in ≤ 10 s (§6.4).
- [ ] `/api/dnc/sync-status` shows accurate `last_run_at` per source.
- [ ] Cache miss → MySQL fallback → result correct (no false negatives).
- [ ] Audit row written for every internal DNC add/remove (who, when, why).
- [ ] Bypass token: minted, single-use redeemed, expired-after-TTL rejected, mismatch-payload rejected.
- [ ] Every bypass grant fires `dnc.bypass.granted` severity page (O01 alert).
- [ ] Bloom snapshot to S3 + restore via `BF.LOADCHUNK` round-trip works in DR test.
- [ ] In-process Bloom fallback works when `valkey-bloom` module is unloaded (dev fallback test).
- [ ] Coverage ≥ 80% on `api/src/dnc/**` and `dialer/internal/dnc/**`.

---

## 16. Bloom approach confirmation

**Engine:** `valkey-bloom` module (BSD-3, native Valkey 8 module).
**Commands used:** `BF.RESERVE`, `BF.MADD`, `BF.MEXISTS`, `BF.EXISTS`,
`BF.SCANDUMP`, `BF.LOADCHUNK`, `BF.INFO`, `BF.DEL` (via standard `DEL`).
**Sizing:** 0.001 FPR, EXPANSION 2 across all four key shapes per §1.2.
**Fallback:** in-process `github.com/bits-and-blooms/bloom/v3` (Go) and
WebAssembly equivalent (TS) populated from MySQL on dialer/api boot if
module unavailable.
**Backup:** nightly `BF.SCANDUMP` chunked to S3; restore via
`BF.LOADCHUNK` on bootstrap with MySQL-rebuild as second-line fallback.
**Failure mode:** fail-closed (refuse to dial) on any Bloom failure
that can't be served by MySQL within latency budget. Compliance
hard-floor invariant per SPEC §4.1.

---

End of PLAN.md.
