# D03 — Phone-Code Timezone Resolver — PLAN

**Module:** D03 (Data track, Phase 1)
**Author:** D03-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 40 citations.
**Depends on (PLANs FROZEN):** F02 (schema; amendments A1/A4/A5 already landed), F04 (Valkey pubsub), C01 (confidence enum consumer).
**Blocks:** C01 (TCPA gate), D02 (import-time tz tagging), E01 (hopper filler gate), T04 (originate-time tz gate).

> **Stakes.** D03 is the upstream input to C01's TCPA quiet-hours gate.
> A wrong timezone = illegal call = $500/$1,500 statutory damages per call.
> The RESEARCH found that 40%+ of US adults have ported their cell across
> timezone boundaries (FCC LNP data), making pure phone-number-based
> resolution an insufficient—and litigation-cited—approach. This PLAN
> specifies a 6-tier cascade that is correct, defensible, fast, and
> auditable. C01 decides what to *do* with the result; D03 decides what
> the result *is*.

---

## 0. TL;DR (10-bullet decision summary)

1. **Six-tier cascade is the contract.** Tier precedence (highest to lowest):
   `lead.known_timezone` → `lead.postal_code` (ZIP→IANA) → `phone.NPA+NXX`
   → `phone.NPA only` → `lead.state` (single-tz states only) →
   `campaign.default_timezone`. No tier may be skipped by configuration.
   C01 handles the `NONE` case via `campaign.unknown_tz_policy`.

2. **In-process map preload is the performance architecture.** Both the Go
   dialer and Node API load `phone_codes` (~165k rows, ~20 MB) and
   `zip_codes` (~33k rows, ~4 MB) into RAM at boot. Hot-path lookup is
   `map[uint32]Entry` keyed on `NPA*1000+NXX` (Go) or `Map<string,Entry>`
   (TS). **Valkey is not on the read path** — it handles pubsub invalidation
   only. p99 target: **<1 ms**; p50 target: **<100 µs**.

3. **Confidence enum is a frozen public interface.** Seven values:
   `KNOWN | ZIP | NXX | NPA | STATE_DEFAULT | CAMPAIGN_DEFAULT | NONE`.
   This enum appears in `call_window_audit.tz_confidence` (C03 hash chain),
   `originate_audit` decisions (T04), D02 import-time tagging, and all
   Prometheus metric labels. It cannot change without an RFC.

4. **Go is the canonical implementation; TypeScript is the authoritative
   mirror.** Go: `dialer/internal/tz/` (used by E01 hopper filler + T04
   originate). TS: `api/src/tz/` (used by D02 CSV import, A04 manual-dial
   UX, admin API). Both consume the same MySQL data via the same preload
   pattern. Phase 1 runs in-process; gRPC `tz.proto` is specified but
   not deployed Phase 1 (deferred to Phase 2).

5. **Phone-number parsing library is pinned.** Go: `nyaruka/phonenumbers
   v1.7.x` (MIT, 2026-04 metadata — confirmed over `lytics/phonenumbers`
   fork). TS: `google-libphonenumber@^1.2.x` (npm, 2.5 M weekly downloads,
   same underlying libphonenumber data). `libphonenumber`'s
   `GetTimezonesForNumber` is NPA-granular only and is used **only** as a
   Tier 4 last-resort safety net, never as the primary TZ source.

6. **ZIP→IANA is precomputed at build time, not runtime.** Build script
   `scripts/build-zip-codes.go` joins Census ZCTA Gazetteer centroids
   (lat/lon) with `evansiroky/timezone-boundary-builder` 2026a polygons
   (point-in-polygon) once per quarter. Output: `db/seeds/zip_codes.csv`
   (~33k rows) committed to repo. `make db-seed` UPSERTs into `zip_codes`.

7. **Eight split-state seeding is ship-blocking.** IN, KY, TN, FL, ID, OR,
   ND, SD, NE have NXX-level timezone splits that NPA-only data cannot
   resolve. The build pipeline `scripts/build-phone-codes.go` fetches
   NANPA CO-Code Utilized Reports + Local Calling Guide `xmlprefix.php`,
   joins rate-center names to `db/seeds/split_state_counties.csv`
   (committed static crosswalk), and derives per-NXX IANA names. The 18
   fixture assertions in §9.1 of the RESEARCH are ship-blocking test gates.

8. **Manual overrides via `phone_codes_overrides` table (A5 already in
   schema).** Admin can insert a row via `POST /api/admin/tz/overrides`
   (RBAC: `admin:system`). Resolver checks overrides before `phone_codes`
   on Tier 3/4. Any write publishes `vici2.phone_codes.invalidate` on
   Valkey; all services reload that NXX within ~1 s via pubsub.

9. **Mobile flag is reported, not acted on by D03.** `NumberType: MOBILE |
   FIXED_LINE | FIXED_OR_MOBILE | TOLL_FREE | PREMIUM_RATE | VOIP | UNKNOWN`
   is included in `ResolveResult`. C01 optionally treats `ZIP` confidence
   with `MOBILE` type as medium confidence (porting risk). D03 reports;
   C01 decides. No D03 code path changes based on mobile flag.

10. **F02 amendments A1/A4/A5 already landed** (verified in schema.prisma
    commit `5943a1e`). D03 PLAN requires **no further F02 schema amendments**.
    The `phone_codes(area_code, exchange_code)` composite PK, `zip_codes`
    table, and `phone_codes_overrides` table are all present and aligned
    with this spec.

---

## 1. Goals and non-goals

### 1.1 Goals

- Implement the 6-tier cascade resolver in Go (canonical) and TypeScript
  (mirror) consuming the same MySQL reference tables.
- Own the build pipeline that produces `db/seeds/phone_codes.csv` (NANPA +
  LCG + split-state crosswalk) and `db/seeds/zip_codes.csv` (Census + TBB
  polygons).
- Own the in-process preload caches and Valkey pubsub invalidation handler.
- Expose `Resolve(ctx, ResolveRequest) → ResolveResult` in Go and
  `resolveTimezone(req) → Promise<ResolveResult>` in TypeScript as the
  sole outward interface. Both are consumed by C01, D02, E01, T04, A04.
- Ship 9 Prometheus metrics (§12.1).
- Provide 18 NXX-level split-state fixture assertions + full tier-coverage
  fixture set as ship-blocking test gates.
- Provide the admin API endpoints for `phone_codes_overrides` management.
- Provide `make tz-debug` CLI for operator ad-hoc lookup (no DB query in
  production hot path — this queries Valkey HASH copy).

### 1.2 Non-goals (explicit deferrals)

- **TZ gate enforcement** — C01 owns the ALLOW/BLOCK/SKIP_UNTIL decision;
  D03 only resolves the timezone and reports confidence.
- **TCPA state rules** — C01 owns the federal + state exception matrix.
- **DNC scrub** — D05 owns all DNC lookups and Bloom filters.
- **Campaign default timezone** — D03 reads `campaigns.default_timezone`
  (caller provides it in `ResolveRequest.CampaignID`; D03 resolves via an
  in-process campaign cache). D03 does not own the campaigns table.
- **gRPC service deployment** — `shared/proto/tz.proto` is specified (§8.3)
  but the gRPC server is not deployed Phase 1 (in-process only).
- **Canada/Caribbean full coverage** — NANPA seed pipeline includes Canadian
  NXXs (same data source, same process), but C01's TCPA gate is US-only.
  D03 will resolve Canadian numbers to IANA names where seed data exists;
  non-NANP numbers fall through to the libphonenumber fallback or `NONE`.
- **Property-based fuzz testing** — defer to Phase 2 hardening
  (gopter + fast-check).
- **Commercial NALENND/NPANXXSource upgrade** — documented in HANDOFF;
  Phase 4 upgrade path.
- **XLSX in D02** — D02 owns the import pipeline; D03 provides `tz.Resolve`
  which D02 calls per row. No D03 changes needed for D02's XLSX Phase 1.5.

---

## 2. Lookup algorithm — the 6-tier cascade (FROZEN)

### 2.1 Tier table

| Tier | Input | Confidence | Latency | When used |
|---|---|---|---|---|
| **1** | `lead.known_timezone` (IANA string) | `KNOWN` | ~50 ns | Always check first; overrides everything |
| **2** | `lead.postal_code` → `zip_codes` map | `ZIP` | <100 µs in-mem | When tier 1 absent AND zip is 5- or 9-digit US |
| **3** | `phone NPA+NXX` → `phone_codes_overrides` then `phone_codes` | `NXX` | <100 µs in-mem | When tier 2 misses; phone parses to NANP E.164 |
| **4** | `phone NPA only` → `phone_codes` collapse OR libphonenumber | `NPA` | <100 µs in-mem / ~5 µs lib | When tier 3 misses (NXX not yet in table) |
| **5** | `lead.state` → `singleTzStateMap` (single-tz states only) | `STATE_DEFAULT` | ~50 ns | When tiers 1-4 miss; **excluded for 8 split states** |
| **6** | `campaign.default_timezone` (admin-set) | `CAMPAIGN_DEFAULT` | ~50 ns | Last-chance fallback |
| **—** | none | `NONE` | n/a | C01 decides BLOCK or ALLOW_WARN per `unknown_tz_policy` |

### 2.2 Split states excluded from Tier 5

Tier 5 is **skipped** for IN, KY, TN, FL, ID, OR, ND, SD, NE. These states
have NXX-level timezone splits. If Tiers 1-4 all miss for a lead in one of
these states, the result is either Tier 6 campaign default or `NONE`. They
are never given a state-default timezone because a single default is legally
indefensible for them.

### 2.3 Go canonical pseudocode

```go
// dialer/internal/tz/resolver.go
func (r *Resolver) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error) {
    // Tier 1 — explicit lead override (highest confidence)
    if req.KnownTimezone != "" {
        if loc, ok := r.lookupLocation(req.KnownTimezone); ok {
            return ResolveResult{IANA: req.KnownTimezone, Location: loc,
                Confidence: ConfKnown, Source: "lead.known_timezone"}, nil
        }
        // Bad IANA string — log + fall through (do not block dial on a typo)
        slog.Warn("invalid lead.known_timezone", "value", req.KnownTimezone, "lead_id", req.LeadID)
    }

    // Parse phone once; cache result in LRU (4096 entries, ~200 B each)
    parsed, parseErr := r.parseE164(req.PhoneE164)

    // Tier 2 — ZIP (US 5-digit or XXXXX-XXXX; mobile flag informational)
    if isValidUSZip(req.Zip) {
        if entry, ok := r.zipCache.Get(zipKey(req.Zip)); ok {
            return result(entry.IANA, entry.Loc, ConfZIP, "zip:"+req.Zip, parsed), nil
        }
    }

    if parseErr == nil {
        // Tier 3 — NPA-NXX: check overrides first, then phone_codes
        nk := npaNxxKey(parsed.NPA, parsed.NXX)
        if entry, ok := r.overrideCache.Get(nk); ok {
            return result(entry.IANA, entry.Loc, ConfNXX,
                "nxx:override:"+parsed.NPA+"-"+parsed.NXX, parsed), nil
        }
        if entry, ok := r.phoneCodesCache.Get(nk); ok {
            return result(entry.IANA, entry.Loc, ConfNXX,
                "nxx:"+parsed.NPA+"-"+parsed.NXX, parsed), nil
        }

        // Tier 4 — NPA only: collapse phone_codes by NPA, else libphonenumber
        if entry, ok := r.npaOnlyCache.Get(parsed.NPA); ok {
            return result(entry.IANA, entry.Loc, ConfNPA, "npa:"+parsed.NPA, parsed), nil
        }
        if zones, err := phonenumbers.GetTimezonesForNumber(parsed.PhoneNumber);
            err == nil && len(zones) > 0 {
            if loc, ok := r.lookupLocation(zones[0]); ok {
                return result(zones[0], loc, ConfNPA,
                    "npa:libphonenumber:"+parsed.NPA, parsed), nil
            }
        }
    }

    // Tier 5 — single-tz state default (NOT for split states)
    if req.State != "" {
        if iana, ok := singleTzStateMap[req.State]; ok {
            loc, _ := r.lookupLocation(iana)
            return result(iana, loc, ConfStateDefault, "state:"+req.State, parsed), nil
        }
        // split state: singleTzStateMap excludes IN/KY/TN/FL/ID/OR/ND/SD/NE
        // → fall through intentionally
    }

    // Tier 6 — campaign default
    if req.CampaignID != "" {
        if iana, ok := r.campaignDefaultCache.Get(req.CampaignID); ok && iana != "" {
            loc, _ := r.lookupLocation(iana)
            return result(iana, loc, ConfCampaignDefault,
                "campaign:"+req.CampaignID, parsed), nil
        }
    }

    // All tiers exhausted
    return ResolveResult{Confidence: ConfNone}, nil
}
```

### 2.4 Algorithmic invariants (test contract; FROZEN)

- **Tier 1 always wins.** A lead with `known_timezone=America/Phoenix` and a
  NY area code resolves to `America/Phoenix` (`KNOWN`).
- **Tier 2 wins over Tier 3.** A ported NY number with `zip=90210` resolves
  to `America/Los_Angeles` (`ZIP`).
- **Overrides preempt phone_codes.** An NXX in `phone_codes_overrides` wins
  over the same NXX in `phone_codes` (Tier 3).
- **Tier 4 uses libphonenumber as last resort.** A valid NANP number not in
  our tables resolves to `NPA` confidence (not `NONE`) via libphonenumber.
  Exception: NPA 999 (invalid) still returns `NONE`.
- **Tier 5 is skipped for the 8 split states.** A lead with `state=IN` and
  no other signals does NOT receive `America/Indiana/Indianapolis` as a
  state default — it goes to Tier 6 or `NONE`.
- **Bad IANA string in `known_timezone` falls through.** If `known_timezone`
  is `Mars/Olympus_Mons`, the resolver logs a warning, falls through to
  Tier 2, and does not hard-error.

---

## 3. Confidence enum (FROZEN public interface)

```go
// dialer/internal/tz/confidence.go (frozen — no changes without RFC)
type Confidence string
const (
    ConfKnown           Confidence = "KNOWN"           // lead.known_timezone (highest)
    ConfZIP             Confidence = "ZIP"             // ZIP centroid → IANA
    ConfNXX             Confidence = "NXX"             // NPA+NXX phone_codes hit
    ConfNPA             Confidence = "NPA"             // NPA-only fallback
    ConfStateDefault    Confidence = "STATE_DEFAULT"   // single-tz state (excludes 8 split)
    ConfCampaignDefault Confidence = "CAMPAIGN_DEFAULT"// admin-set campaign default
    ConfNone            Confidence = "NONE"            // unresolvable; caller decides
)
```

```typescript
// shared/types/src/tz.ts (TypeScript mirror)
export type Confidence = 'KNOWN' | 'ZIP' | 'NXX' | 'NPA' | 'STATE_DEFAULT' | 'CAMPAIGN_DEFAULT' | 'NONE';
```

**Defensibility ranking consumed by C01:**

| Confidence | Legal standing | C01 treatment |
|---|---|---|
| `KNOWN` | High — explicit lead-stated location | ALLOW |
| `ZIP` (landline) | High — physical address | ALLOW |
| `ZIP` (mobile) | Medium — zip may be stale/ported | ALLOW; C01 may flag for `warn_on_mobile_zip` (Phase 4) |
| `NXX` | Medium-High — best industry-standard for portable numbers | ALLOW |
| `NPA` | Medium — NPA can span tz boundaries (split states) | ALLOW; C01 logs warning if state is one of 8 |
| `STATE_DEFAULT` | Low-Medium — CRM-recorded state may be stale | ALLOW |
| `CAMPAIGN_DEFAULT` | Low — administrator guess | ALLOW; logged as "fallback used" |
| `NONE` | N/A | BLOCK or ALLOW_WARN per `campaign.unknown_tz_policy` |

---

## 4. Go implementation (`dialer/internal/tz/`)

### 4.1 Types

```go
// dialer/internal/tz/types.go
type NumberType int
const (
    NumberTypeUnknown       NumberType = iota
    NumberTypeFixedLine
    NumberTypeMobile
    NumberTypeFixedOrMobile
    NumberTypeTollFree
    NumberTypePremiumRate
    NumberTypeVoip
)

type ResolveRequest struct {
    LeadID        int64   // optional; 0 = phone-only lookup
    PhoneE164     string  // required; "+13175551212"
    KnownTimezone string  // optional; IANA string from lead.known_timezone
    Zip           string  // optional; lead.postal_code
    State         string  // optional; 2-char US state code
    CampaignID    string  // optional; for Tier 6 default
}

type ResolveResult struct {
    IANA       string         // "America/New_York"; "" if NONE
    Location   *time.Location // pre-loaded; nil if NONE
    Confidence Confidence
    Source     string         // "lead.known_timezone" | "zip:30024" | "nxx:317-555" | ...
    NPA        string
    NXX        string
    NumberType NumberType     // informational; MOBILE flag reported to C01
}

type Resolver struct {
    db              *sql.DB
    valkey          *redis.Client          // pubsub only, not hot-path
    phoneCodesCache atomic.Value           // *map[uint32]Entry
    overrideCache   atomic.Value           // *map[uint32]Entry (phone_codes_overrides)
    npaOnlyCache    atomic.Value           // *map[string]Entry (collapsed by NPA)
    zipCache        atomic.Value           // *map[uint32]Entry
    locCache        sync.Map               // string → *time.Location
    parsedLRU       *lru.Cache[string, parsed]
    campaignLRU     *lru.Cache[string, string] // campaignID → default IANA; TTL 5 min
}

func New(db *sql.DB, vk *redis.Client) *Resolver
func (r *Resolver) Preload(ctx context.Context) error
func (r *Resolver) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error)
func (r *Resolver) ResolveBatch(ctx context.Context, reqs []ResolveRequest) ([]ResolveResult, error)
func (r *Resolver) Subscribe(ctx context.Context) error // starts Valkey pubsub goroutine
```

### 4.2 Cache design

| Cache | Data | Key | Size | Refresh |
|---|---|---|---|---|
| `phoneCodesCache` | `phone_codes` table | `uint32(NPA*1000+NXX)` | ~20 MB | Boot preload; 6h periodic; pubsub-triggered reload |
| `overrideCache` | `phone_codes_overrides` | same | ~1 MB | Boot preload; pubsub-triggered (admin edit) |
| `npaOnlyCache` | Collapsed from `phone_codes` (first distinct IANA per NPA) | `string` NPA | ~1 MB | Same as phoneCodesCache |
| `zipCache` | `zip_codes` table | `uint32(zip as int)` | ~4 MB | Boot preload; 24h periodic |
| `locCache` | `*time.Location` pointers | `string` IANA name | ~250 KB (50 entries) | Lazy-populate; never evicted |
| `parsedLRU` | `phonenumbers.Parse` results | `string` E.164 | ~1 MB (4096 × ~200 B) | LRU eviction |
| `campaignLRU` | `campaigns.default_timezone` | `string` campaignID | ~50 KB (1000 × ~50 B) | LRU; TTL 5 min; pubsub-busted on campaign edit |

**Map key design:** `uint32(NPA_as_int * 1000 + NXX_as_int)` — eliminates
string allocation on every hot-path lookup. NPA `"317"` = 317; NXX `"555"` =
555; key = `317_555` = 317555. Max NANP key = 999999 — fits in `uint32`.

**Atomic snapshot pattern:** `atomic.Value[*map]` allows lock-free reads.
Reload builds a new map, then `phoneCodesCache.Store(&freshMap)`. No RWMutex
contention on the hot path.

### 4.3 Boot-time preload (FROZEN)

```go
// dialer/internal/tz/preload.go
func (r *Resolver) Preload(ctx context.Context) error {
    // Load phone_codes (primary)
    phoneRows, err := r.db.QueryContext(ctx,
        `SELECT area_code, exchange_code, tz_iana FROM phone_codes`)
    // ... build fresh map, atomic.Value.Store ...

    // Load phone_codes_overrides
    ovRows, err := r.db.QueryContext(ctx,
        `SELECT area_code, exchange_code, tz_iana FROM phone_codes_overrides`)
    // ...

    // Build NPA-only collapse (first distinct IANA per NPA across phone_codes)
    npaMap := make(map[string]Entry, 800)
    for npaStr, entries := range grouped { npaMap[npaStr] = entries[0] }
    // ...

    // Load zip_codes
    zipRows, err := r.db.QueryContext(ctx,
        `SELECT zip, tz_iana FROM zip_codes`)
    // ...

    return nil
}
```

Boot **blocks** until preload succeeds. If MySQL is down at start, the
service refuses to start (fail-fast). This is intentional: hot-path
correctness depends on the cache; a partial or missing cache is worse than
no service.

### 4.4 Valkey pubsub invalidation

```
Channel: vici2.phone_codes.invalidate
Payload: "<npa><nxx>" (6-char, specific NXX) | "FULL" (full reload)
```

When the admin writes to `phone_codes_overrides` via the REST API, the
handler publishes `XPUBLISH vici2.phone_codes.invalidate "<npa><nxx>"`. All
processes subscribed to this channel reload the affected override row from
MySQL and patch the in-memory override map (single-row fetch, not full
reload). On `"FULL"`, call `Preload()` again. Partial patch avoids
thundering-herd on admin edits.

```go
// dialer/internal/tz/invalidate.go
func (r *Resolver) Subscribe(ctx context.Context) error {
    sub := r.valkey.Subscribe(ctx, "vici2.phone_codes.invalidate")
    go func() {
        for msg := range sub.Channel() {
            if msg.Payload == "FULL" {
                r.Preload(context.Background())
                continue
            }
            npa, nxx := msg.Payload[:3], msg.Payload[3:]
            r.reloadNXX(npa, nxx) // single-row MySQL fetch
        }
    }()
    return nil
}
```

---

## 5. TypeScript implementation (`api/src/tz/`)

### 5.1 Types (FROZEN wire shape)

```typescript
// api/src/tz/types.ts
export type Confidence = 'KNOWN' | 'ZIP' | 'NXX' | 'NPA' | 'STATE_DEFAULT' | 'CAMPAIGN_DEFAULT' | 'NONE';
export type NumberType = 'UNKNOWN' | 'FIXED_LINE' | 'MOBILE' | 'FIXED_OR_MOBILE'
                       | 'TOLL_FREE' | 'PREMIUM_RATE' | 'VOIP';

export interface ResolveRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string;
  zip?: string;
  state?: string;
  campaignId?: string;
}

export interface ResolveResult {
  iana: string;           // '' if NONE
  confidence: Confidence;
  source: string;
  npa?: string;
  nxx?: string;
  numberType?: NumberType;
}
```

### 5.2 Resolver module

```typescript
// api/src/tz/resolve.ts
export async function resolveTimezone(req: ResolveRequest): Promise<ResolveResult>;
export async function preload(prisma: PrismaClient, valkey: Redis): Promise<void>;
export function subscribe(valkey: Redis): void;
```

The TS resolver mirrors the Go tier-cascade logic exactly, using:
- **`google-libphonenumber@^1.2.x`** for `parsePhoneNumber` + `getNumberType`
  + `getTimezonesForNumber` (NPA-only fallback safety net, same role as Go).
- **`luxon`** for IANA tz arithmetic (matches C01 choice per C01 PLAN §4.2).
- **`Map<string, Entry>`** for in-process cache (TS Map keyed on string
  `"${NPA}${NXX}"` for the phone codes; string zip for zip_codes).
- **`ioredis`** subscriber for Valkey pubsub invalidation.

Preload fires during Fastify boot (`onReady` hook). If MySQL is unreachable,
boot fails (same fail-fast behavior as Go).

### 5.3 Library pins

| Language | Library | Version | Role |
|---|---|---|---|
| Go | `nyaruka/phonenumbers` | `v1.7.x` (pinned in `go.mod`) | Parse, NPA/NXX extract, libphonenumber TZ fallback |
| TypeScript | `google-libphonenumber` | `^1.2.x` (pinned in `package.json`) | Same |
| TypeScript | `luxon` | `^3.x` (already in repo per C01) | IANA tz DST arithmetic |

**Rationale for `nyaruka` over `lytics`:** `nyaruka/phonenumbers` is the
primary community-maintained Go port (MIT, active in 2026, same metadata
cadence as libphonenumber Java). The `lytics` fork has diverged primarily for
internal tooling; RESEARCH §8.1 (cite [10]) recommends against it for Phase 1.

**Rationale for `google-libphonenumber` over `awesome-phonenumber`:**
RESEARCH §8.2 recommends `google-libphonenumber` for broader weekly-download
adoption (2.5M/week vs ~500k/week) and direct provenance from the canonical
Java library. Pinning to `^1.2.x` to stay on the same major.

---

## 6. Data ingestion pipeline (FROZEN)

### 6.1 `scripts/build-phone-codes.go` — NANPA + LCG + crosswalk

**Annual cadence (cron Jan 15 + manual `make build-phone-codes`):**

```
Step 1: Fetch NANPA Central Office Code Utilized Reports
  curl "https://nationalnanpa.com/enas/coCodeReportUnsecured.do?reportType=7&state=$STATE&npa=ALL&format=csv"
  → 50 downloads (one per state + territories); concatenate to one TSV.

Step 2: For each non-split-state NPA-NXX row:
  tz_iana = singleTzStateMap[state]   // compiled-in constant

Step 3: For each split-state NPA-NXX row (IN, KY, TN, FL, ID, OR, ND, SD, NE):
  rc = LCG xmlprefix lookup(npa, nxx) → rate_center_name
  county_fips = rate_center_to_county[state][rc]  // static lookup (see §6.3)
  tz_iana = split_state_county_iana[(state, county_fips)]  // crosswalk CSV

Step 4: UPSERT output to db/seeds/phone_codes.csv
  Columns: npa, nxx, state, county, tz_iana, confidence(NXX)

Step 5: Rollup NPA-only collapse → db/seeds/phone_codes_npa.csv
  (first distinct tz per NPA across phone_codes; used for Tier 4 preload)
```

**LCG polite-scraping rules:** ≤1 req/s, polite User-Agent string
`"vici2-tz-builder/1.0 (NANP research; contact: ops@<domain>)"`, aggressive
caching (`curl --time-cond`). Attribution in `db/seeds/README.md`. No formal
TOS; community tolerance documented in RESEARCH §5.2 (cite [7]).

**NANPA fetch failure policy:** If fetch fails 3× with exponential backoff,
alert ops via `make build-phone-codes` exit code 1 and fall back to last
committed `db/seeds/phone_codes.csv`. Never block a deploy on a seed refresh.

### 6.2 `scripts/build-zip-codes.go` — Census ZCTA + timezone-boundary-builder

**Quarterly cadence (`make build-zip-codes`):**

```
Step 1: Download Census ZCTA5 Gazetteer (lat/lon centroids)
  https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip

Step 2: Download timezone-boundary-builder 2026a GeoJSON polygons
  https://github.com/evansiroky/timezone-boundary-builder/releases/tag/2026a
  (ODbL license; attributed in db/seeds/README.md)

Step 3: For each ZCTA centroid, run point-in-polygon against TBB polygons
  → IANA tz name
  (pre-computed once; output is db/seeds/zip_codes.csv — no polygon dependency at runtime)

Step 4: UPSERT to db/seeds/zip_codes.csv
  Columns: zip, tz_iana, state, confidence(ZIP)
```

The build is run at build time and on quarterly cron; the output CSV is
committed to the repo. Production services load from MySQL, not from polygons.
`timezone-boundary-builder` polygons are ~50 MB and have `ODbL` license;
they are a build-time dependency only and not redistributed with the binary.

### 6.3 Static crosswalk files (committed to repo)

```
db/seeds/
  phone_codes.csv          (~165k rows; NPA, NXX, state, county, tz_iana)
  phone_codes_npa.csv      (~800 rows; NPA, tz_iana; Tier 4 collapse)
  zip_codes.csv            (~33k rows; zip, tz_iana, state)
  split_state_counties.csv (static; state, county_name, county_fips, iana_tz)
  README.md                (source attribution for NANPA, LCG, Census, TBB)
```

`split_state_counties.csv` maps county FIPS codes to IANA tz names for the
8 split states. This file is curated from DOT 49 CFR Part 71 boundary
descriptions + IANA `zone1970.tab`. It changes only when Congress or DOT
alters timezone boundaries (rare; ~3 times in past 20 years). It is
hand-maintained and reviewed on merge.

### 6.4 Seed lifecycle

```
make db-seed
  → prisma db seed   (or equivalent: node db/seed.js)
  → UPSERTs phone_codes.csv → phone_codes (INSERT ... ON DUPLICATE KEY UPDATE tz_iana, state, county)
  → UPSERTs zip_codes.csv   → zip_codes   (INSERT ... ON DUPLICATE KEY UPDATE tz_iana, state)
  → Publishes vici2.phone_codes.invalidate "FULL" to Valkey
```

Idempotent: `make db-seed` is safe to run at any time (noop if unchanged).

---

## 7. Split-state seeding plan (8 states — ship-blocking)

The 8 split states are: **IN, KY, TN, FL, ID, OR, ND, SD, NE**.

The `singleTzStateMap` constant explicitly **excludes** these 8 states. Any
lead in these states with a missing Tier 3/4 hit goes to Tier 6 or `NONE`.

Indiana is the most complex: it has **8 distinct IANA zones**:
- `America/Indiana/Indianapolis` (majority)
- `America/Indiana/Knox` (Starke County)
- `America/Indiana/Marengo` (Crawford County)
- `America/Indiana/Petersburg` (Pike County)
- `America/Indiana/Tell_City` (Perry County)
- `America/Indiana/Vevay` (Switzerland County)
- `America/Indiana/Vincennes` (Knox+Daviess Counties)
- `America/Indiana/Winamac` (Pulaski County)

These are seeded per-NXX via LCG rate-center → county FIPS crosswalk.
**Do not simplify Indiana to `America/Chicago` / `America/New_York`** — the
IANA historical DST exceptions for Indiana sub-zones are legally significant.

### 7.1 Ship-blocking fixture assertions (18 cases)

All 18 must pass before IMPL is considered complete:

| # | State | Phone (representative NXX) | Expected IANA | Tier |
|---|---|---|---|---|
| 1 | IN | +12199335555 (Hammond, Lake Co.) | America/Chicago | NXX |
| 2 | IN | +13175551212 (Indianapolis, Marion Co.) | America/Indiana/Indianapolis | NXX |
| 3 | IN | +18125551212 (Tell City, Perry Co.) | America/Indiana/Tell_City | NXX |
| 4 | KY | +12705551212 (Paducah, McCracken Co.) | America/Chicago | NXX |
| 5 | KY | +18595551212 (Lexington, Fayette Co.) | America/New_York | NXX |
| 6 | TN | +19015551212 (Memphis, Shelby Co.) | America/Chicago | NXX |
| 7 | TN | +18655551212 (Knoxville, Knox Co.) | America/New_York | NXX |
| 8 | FL | +18505551212 (Pensacola NXX) | America/Chicago | NXX |
| 9 | FL | +18505551212 (Tallahassee NXX) | America/New_York | NXX |
| 10 | ID | +12085551212 (Boise) | America/Boise | NXX |
| 11 | OR | +15415551212 (Ontario, Malheur Co.) | America/Boise | NXX |
| 12 | OR | +15415551212 (Bend, Deschutes Co.) | America/Los_Angeles | NXX |
| 13 | ND | +17015551212 (Fargo, Cass Co.) | America/Chicago | NXX |
| 14 | ND | +17015551212 (Dickinson, Stark Co.) | America/Denver | NXX |
| 15 | SD | +16055551212 (Sioux Falls, Minnehaha Co.) | America/Chicago | NXX |
| 16 | SD | +16055551212 (Rapid City, Pennington Co.) | America/Denver | NXX |
| 17 | NE | +13085551212 (Scottsbluff, Scotts Bluff Co.) | America/Denver | NXX |
| 18 | NE | +14025551212 (Omaha, Douglas Co.) | America/Chicago | NXX |

Note: rows 8/9 and 11/12 and 13/14 etc. use **different NXX values** within
the same NPA. Test fixtures must use the actual NXX assigned to those cities
(sourced from LCG during seed build; pinned in `fixtures_test.json`).

---

## 8. API surfaces (FROZEN)

### 8.1 Go canonical (`dialer/internal/tz/`)

```go
// Public interface — every caller uses only these:
func (r *Resolver) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error)
func (r *Resolver) ResolveBatch(ctx context.Context, reqs []ResolveRequest) ([]ResolveResult, error)
```

`ResolveBatch` is the E01 hopper-fill interface. E01 fetches a batch of leads
from MySQL and calls `ResolveBatch` rather than N individual `Resolve` calls.
`ResolveBatch` amortizes LRU-parse lookups over the batch and internally
parallelizes with a `sync.WaitGroup` (goroutine-per-item up to 64 concurrent).
Target: 1000 leads in <500 µs aggregate.

Consumers by caller:
- **E01 hopper filler** — calls `ResolveBatch` per bulk-fetch of candidates.
- **T04 originate gate** — calls `Resolve` per outbound attempt (last-chance gate).
- **A04 manual dial (via TS mirror)** — calls TS `resolveTimezone`.

### 8.2 TypeScript mirror (`api/src/tz/`)

```typescript
// api/src/tz/resolve.ts
export async function resolveTimezone(req: ResolveRequest): Promise<ResolveResult>
export async function resolveBatch(reqs: ResolveRequest[]): Promise<ResolveResult[]>
export async function preload(prisma: PrismaClient, valkey: Redis): Promise<void>
export function subscribe(valkey: Redis): void
```

`resolveBatch` is the D02 CSV import interface (called once per batch of 500
rows from the pipeline Stage 6 DNC+TCPA-scrub Transform, per D02 PLAN §2.1).

### 8.3 Admin REST endpoints

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/tz/overrides` | `admin:read` | List all `phone_codes_overrides` rows |
| `POST` | `/api/admin/tz/overrides` | `admin:system` | Add or update override; publishes pubsub invalidate |
| `DELETE` | `/api/admin/tz/overrides/:npa/:nxx` | `admin:system` | Remove override; publishes pubsub invalidate |
| `GET` | `/api/admin/tz/lookup` | `admin:read` | Ad-hoc debug lookup (consults Valkey HASH, not hot-path map) |
| `POST` | `/api/admin/tz/reload` | `admin:system` | Trigger full cache reload on all processes (publishes `"FULL"` pubsub) |

Rate limits (F04 Valkey store):
- `POST /overrides`: 10 rpm (DDL-adjacent; rare operation)
- `GET /lookup`: 60 rpm (debug; not on hot path)
- `POST /reload`: 2 rpm (full reload is expensive)

Response shape for `GET /api/admin/tz/lookup`:
```json
{
  "phone_e164": "+13175551212",
  "npa": "317", "nxx": "555",
  "iana": "America/Indiana/Indianapolis",
  "confidence": "NXX",
  "source": "nxx:317-555",
  "number_type": "FIXED_OR_MOBILE",
  "from_override": false,
  "lookup_at": "2026-05-13T14:00:00.000000Z"
}
```

### 8.4 gRPC contract (specified, not deployed Phase 1)

```proto
// shared/proto/tz.proto (Phase 2 deployment)
syntax = "proto3";
package vici2.tz.v1;

service TimezoneService {
  rpc Resolve(ResolveRequest) returns (ResolveResult);
  rpc ResolveBatch(ResolveBatchRequest) returns (ResolveBatchResult);
}

enum Confidence {
  CONFIDENCE_UNSPECIFIED = 0;
  KNOWN = 1; ZIP = 2; NXX = 3; NPA = 4;
  STATE_DEFAULT = 5; CAMPAIGN_DEFAULT = 6; NONE = 7;
}

message ResolveRequest {
  int64 lead_id = 1; string phone_e164 = 2; string known_timezone = 3;
  string zip = 4; string state = 5; string campaign_id = 6;
}

message ResolveResult {
  string iana = 1; Confidence confidence = 2; string source = 3;
  string npa = 4; string nxx = 5; string number_type = 6;
}

message ResolveBatchRequest { repeated ResolveRequest requests = 1; }
message ResolveBatchResult  { repeated ResolveResult results = 1; }
```

The `.proto` file is committed Phase 1 to establish the contract. The gRPC
server is deployed in Phase 2 if cross-language consistency drift emerges.
Phase 1: Go and TS each run their own in-process copy from the same MySQL
data; correctness is guaranteed by the shared seed data, shared test fixtures
(`dialer/internal/tz/fixtures_test.go` and `api/src/tz/__tests__/fixtures.json`
are the same file), and the CI gate at §16.2.

---

## 9. `make tz-debug` CLI

Phase 1 operator tool (no hot-path involvement):

```bash
# Usage:
make tz-debug PHONE=+13175551212
make tz-debug PHONE=+12199335555 ZIP=46394 STATE=IN

# Implementation: api/src/tz/debug-cli.ts
# Queries Valkey HASH phone_codes:{NPA}{NXX} (populated as side-write
# from admin preload — see §4.4 "Valkey HASH copy" in RESEARCH §4.1).
# Also shows which tier resolved and what the override table holds.
```

If M03 admin UI is not yet on schedule, this CLI is the Phase 1 placeholder
for the admin override workflow (create override → `make tz-debug` → verify).

---

## 10. Schema — no new additions required (FROZEN)

All three D03 schema amendments (A1, A4, A5) are already present in
`api/prisma/schema.prisma` (commit `5943a1e feat(F02): merge MySQL schema
branch with amendments A1-A6`):

| Amendment | Table | Status |
|---|---|---|
| A1 | `phone_codes(area_code CHAR(3), exchange_code CHAR(3))` composite PK; `tz_iana VARCHAR(40)`; `confidence ENUM(NPA, NXX)` | **LANDED** |
| A4 | `zip_codes(zip CHAR(5) PK, tz_iana VARCHAR(40), state CHAR(2))` | **LANDED** |
| A5 | `phone_codes_overrides(area_code, exchange_code, tz_iana, reason, created_by_user_id)` | **LANDED** |

**No F02 migration is needed for D03 IMPLEMENT.** D03 only needs `make db-seed` to populate the reference tables.

One observation: the existing `zip_codes` model lacks a `createdAt` /
`updatedAt` timestamp (unlike every other table in the schema). This is
intentional (global reference table; no per-row change tracking needed) and
consistent with the F02 convention for reference tables. No amendment required.

---

## 11. Prometheus metrics (FROZEN names)

```
vici2_tz_resolve_total{confidence, source_tier}          counter
vici2_tz_resolve_duration_seconds{source_tier}           histogram
  buckets: [100ns, 1µs, 10µs, 100µs, 1ms, 10ms]
  SLO: p99 < 1ms; alert at 2ms (sustained over 5 min)

vici2_tz_split_state_collisions_total{state, npa}        counter
  Alert: >100/day (NPA fallback on a known-split state = seed gap)

vici2_tz_unknown_total{reason}                           counter
  reason: bad_zip | invalid_phone | no_state | no_default | bad_known_tz

vici2_tz_cache_size{cache}                               gauge
  cache: phone_codes | overrides | npa_only | zip | location | parsed_lru

vici2_tz_cache_hits_total{cache}                         counter
vici2_tz_cache_misses_total{cache}                       counter
vici2_tz_invalidations_total{reason}                     counter
  reason: admin | periodic_6h | periodic_24h | pubsub | full_reload

vici2_tz_phone_codes_loaded                              gauge
  (number of NXX entries currently in process map)
vici2_tz_phone_codes_age_seconds                         gauge
  Alert: > 86400 (24h) = stale seed data; page ops
```

All metric names registered in `dialer/internal/tz/metrics.go` (Go) and
`api/src/tz/metrics.ts` (TS, prom-client). The TS side emits to the Fastify
prom-client instance (F01 convention).

---

## 12. Performance targets (FROZEN; CI-enforced)

### 12.1 Latency SLO

| Tier | Operation | p50 target | p99 SLO | Hard ceiling |
|---|---|---|---|---|
| 1 (KNOWN) | string compare + locCache hit | ~100 ns | 1 ms | 10 ms |
| 2 (ZIP) | string→uint + map.Get + locCache | ~150 ns | 1 ms | 10 ms |
| 3 (NXX) | parsedLRU hit + map.Get | ~500 ns | 1 ms | 10 ms |
| 4 (NPA) | parsedLRU miss + phonenumbers.Parse + map.Get | ~5 µs | 1 ms | 10 ms |
| 5 (STATE) | map.Get | ~50 ns | 1 ms | 10 ms |
| 6 (CAMPAIGN) | lru.Get | ~50 ns | 1 ms | 10 ms |
| ResolveBatch(1000) | all tiers; goroutine pool | < 500 µs total | 2 ms | 10 ms |

### 12.2 Optimizations

1. **Parse cache:** `phonenumbers.Parse` is ~5 µs cold; LRU-4096 makes
   repeated hot leads ~200 ns.
2. **Pre-loaded `*time.Location`:** `time.LoadLocation` is ~10 µs cold (reads
   tzdata file); `locCache sync.Map` caches all ~50 US IANA names post-warmup.
3. **Compact uint32 map key:** eliminates string allocation on every hit.
4. **Atomic snapshot:** `atomic.Value[*map]` — no RWMutex on read path.
5. **No return-value allocation on cache hit:** `ResolveResult` returned by
   value; `Source` and `IANA` are interned string pointers from the cache.
6. **Batch goroutine pool:** `ResolveBatch` uses `sync.WaitGroup` with bounded
   goroutine fan-out (max 64). Amortizes LRU lookups across the batch.

### 12.3 CI performance gate

```
# Go benchmarks (CI nightly; fail on regression)
go test -bench=BenchmarkResolveTier1 -benchtime=5s ./dialer/internal/tz/
go test -bench=BenchmarkResolveTier3_NXX -benchtime=5s ./dialer/internal/tz/
go test -bench=BenchmarkResolveBatch1000 -benchtime=5s ./dialer/internal/tz/

# Pass criteria: BenchmarkResolveTier1 < 500 ns/op; BenchmarkResolveTier3_NXX < 2 µs/op;
#   BenchmarkResolveBatch1000 < 1 ms/op (total, not per-item)
```

---

## 13. Failure modes and degradation

| Failure | Behavior | Recovery |
|---|---|---|
| MySQL down at boot | Service refuses to start (fail-fast) | systemd restart loop; Prometheus alert fires when up |
| MySQL down at runtime | In-process map stays valid; no hot-path impact | Periodic refresh skipped; alert if `phone_codes_age_seconds > 86400` |
| Valkey down | No pubsub invalidation; maps may be up to 6h stale (periodic refresh) | Tolerated; 6h periodic refresh fires regardless |
| `time.LoadLocation` fails for IANA in table | Log error, skip entry, fall through to next tier | Bug in seed data — alert, fix CSV, `make db-seed` |
| `phonenumbers.Parse` panics | Recovered by `recover()` in parse wrapper; result NONE; `vici2_tz_parse_panics_total++` | Library bug — file upstream, deploy patched binary |
| Tier 1-6 all miss → NONE | Return `ConfNone`; C01 decides BLOCK vs warn per `campaign.unknown_tz_policy` | No call placed; lead visible in M03 admin UI with `tz_blocked=true` |
| NXX not in phone_codes (new NANPA assignment) | Tier 4 NPA fallback fires; `vici2_tz_split_state_collisions_total` increments if state is one of 8 | Quarterly seed refresh picks it up; override via admin API for urgent cases |
| Bad IANA in `lead.known_timezone` | Logs warning; falls through to Tier 2 | Agent/CRM corrects data; lead re-resolves on next dial |
| `phone_codes_overrides` MySQL unavailable at preload | Override map empty; falls through to `phone_codes` | No data loss; overrides re-populate on next `POST /reload` |

---

## 14. Files to create

### 14.1 Go (`dialer/`)

```
dialer/internal/tz/
  types.go              — ResolveRequest, ResolveResult, Confidence, NumberType
  resolver.go           — Resolver struct + Resolve() + ResolveBatch()
  preload.go            — Preload() boot-time loader + periodic refresh goroutine
  parse.go              — phonenumbers.Parse wrapper + LRU (parsedLRU)
  states.go             — singleTzStateMap const (compiled-in; excludes 8 split states)
  locations.go          — *time.Location lazy cache (locCache sync.Map)
  invalidate.go         — Valkey pubsub subscriber + reloadNXX()
  metrics.go            — Prometheus collectors (all 9 metrics)
  admin.go              — reloadFromAdmin() called by REST handler
  fixtures_test.json    — shared fixture set (27+ cases incl. 18 split-state assertions)
  resolver_test.go      — table-driven unit tests (fixtures_test.json + algorithmic invariants)
  resolver_bench_test.go— BenchmarkResolveTier1/3/Batch1000
```

### 14.2 TypeScript (`api/`)

```
api/src/tz/
  types.ts              — ResolveRequest, ResolveResult, Confidence, NumberType (TS)
  resolve.ts            — resolveTimezone() + resolveBatch() + preload() + subscribe()
  preload.ts            — Fastify onReady hook + periodic 6h timer
  parse.ts              — google-libphonenumber wrapper + Map-based parse cache
  states.ts             — singleTzStateMap literal (TS equivalent of Go const)
  invalidate.ts         — ioredis SUBSCRIBE handler
  metrics.ts            — prom-client collectors (parity with Go)
  handlers/
    overrides.ts        — GET/POST/DELETE /api/admin/tz/overrides handlers
    lookup.ts           — GET /api/admin/tz/lookup handler
    reload.ts           — POST /api/admin/tz/reload handler
  index.ts              — Fastify plugin: route registration + preload hook
  __tests__/
    resolver.spec.ts    — vitest table-driven (uses fixtures_test.json)
    states.spec.ts      — singleTzStateMap excludes 8 split states; includes all single-tz
    handlers/
      overrides.spec.ts
      lookup.spec.ts
      reload.spec.ts
    integration/
      preload.spec.ts   — real MySQL (testcontainers); map size matches row count
      pubsub.spec.ts    — write override → pubsub fires → map updated within 2s
      split-states.spec.ts — 18 fixture assertions against real MySQL seed
```

### 14.3 Shared

```
shared/proto/tz.proto                   — gRPC contract (Phase 2 deployment)
shared/types/src/tz.ts                  — Confidence, NumberType, ResolveRequest, ResolveResult (re-exported via @vici2/types)
shared/events/tz-events.json            — JSON Schema for vici2.phone_codes.invalidate payload
```

### 14.4 Scripts + seeds

```
scripts/
  build-phone-codes.go                  — NANPA CO-Code + LCG → phone_codes.csv + phone_codes_npa.csv
  build-zip-codes.go                    — Census ZCTA + TBB polygons → zip_codes.csv

db/seeds/
  phone_codes.csv                       — ~165k rows (NPA, NXX, state, county, tz_iana, confidence)
  phone_codes_npa.csv                   — ~800 rows (NPA, tz_iana; Tier 4 NPA-only collapse)
  zip_codes.csv                         — ~33k rows (zip, tz_iana, state, confidence)
  split_state_counties.csv              — static; state, county_name, county_fips, iana_tz
  README.md                             — source attribution (NANPA, LCG, Census, TBB ODbL)
```

### 14.5 Makefile targets (add to root Makefile)

```makefile
build-phone-codes:     ## Refresh db/seeds/phone_codes.csv from NANPA + LCG
build-zip-codes:       ## Refresh db/seeds/zip_codes.csv from Census + TBB polygons
db-seed-tz:            ## UPSERT phone_codes + zip_codes + publish FULL invalidate
tz-debug PHONE=:       ## Ad-hoc resolver debug (Valkey HASH lookup, not hot-path)
test-tz:               ## Run all D03 unit + integration tests
bench-tz:              ## Run Go benchmarks for D03
```

---

## 15. Test plan

### 15.1 Unit tests — Go (go test)

- **Algorithmic invariants** (§2.4): 6 invariant assertions as named sub-tests.
- **Fixture table** (27+ cases from `fixtures_test.json`): tier 1 override,
  tier 2 ZIP, tier 3 NXX, tier 4 NPA+libphonenumber, tier 5 single-state,
  tier 6 campaign, NONE, bad IANA passthrough.
- **18 split-state fixtures** (§7.1): ship-blocking; all must pass.
- **`singleTzStateMap`**: asserts exactly 41 state/territory entries present
  (all US states + DC + PR/VI/GU/MP/AS that are single-tz); asserts 8 split
  states absent.
- **Benchmark gate** (see §12.3).

### 15.2 Unit tests — TypeScript (vitest)

- Mirror of §15.1 using `fixtures_test.json` (same file, loaded via
  `import fixs from '../../dialer/internal/tz/fixtures_test.json'`).
- `states.spec.ts`: `singleTzStateMap` object excludes 8 split states.
- Handler unit tests: Zod validation, RBAC enforcement stubs, response shapes.

### 15.3 Integration tests — TypeScript (vitest + testcontainers)

| Test | Description | Pass criterion |
|---|---|---|
| `preload.spec.ts` | Real MySQL (testcontainers) + seed CSV | `phoneCodesCache` row count == `phone_codes` table count |
| `pubsub.spec.ts` | Write override via API → pubsub fires → in-memory map updated | Map entry changes within 2 s |
| `split-states.spec.ts` | All 18 split-state fixtures against seeded MySQL | All 18 match expected IANA |
| `tenant-isolation.spec.ts` | Admin override endpoints: cross-tenant access | N/A — `phone_codes_overrides` is global; RBAC (admin:system) is the gate; test asserts non-admin gets 403 |

### 15.4 Integration tests — Go

- `TestPreloadSize`: MySQL seeded with 1000 mock NXX rows; `Preload()`;
  assert `phoneCodesCache` len == 1000.
- `TestPubsubInvalidation`: insert override row; `PUBLISH`; assert map
  updated within 2 s.
- `TestResolveBatch1000`: 1000 varied leads; `ResolveBatch`; assert p99 < 2 ms.
- `TestSplitStateFixtures`: all 18 fixtures; assert IANA + confidence match.

### 15.5 Performance (CI-enforced)

- Go benchmarks (§12.3): fail on regression (automated via nightly CI job).
- No k6 load test for D03 directly (D03 is in-process; latency captured
  within E01 and T04 k6 tests as part of their dial-path benchmarks).

### 15.6 Coverage targets

- `dialer/internal/tz/**`: ≥ 80% line coverage (higher than default —
  compliance-critical).
- `api/src/tz/**`: ≥ 80% line coverage.
- 18 split-state fixtures: 100% (ship-blocking).
- Algorithmic invariants (§2.4): 100%.

### 15.7 Run commands

```bash
make test-tz                   # all Go + TS unit + integration
go test ./dialer/internal/tz/... -v
cd api && pnpm exec vitest run src/tz
make bench-tz                  # Go benchmarks
```

---

## 16. Acceptance criteria

- [ ] **6-tier cascade implemented** in Go and TS; all 6 tiers exercised
      by fixture tests.
- [ ] **18 split-state fixtures pass** (§7.1) — ship-blocking gate; CI fails
      if any assertion fails.
- [ ] **Algorithmic invariants hold** (§2.4): tier 1 always wins; tier 5 skips
      8 split states; bad IANA falls through; libphonenumber fires for Tier 4.
- [ ] **Confidence enum frozen** with 7 values; TS types in `@vici2/types`.
- [ ] **`phone_codes` seeded** from NANPA + LCG; ~165k rows; `make db-seed`
      idempotent.
- [ ] **`zip_codes` seeded** from Census ZCTA + TBB; ~33k rows; `make db-seed`
      idempotent.
- [ ] **In-process map preload** at boot for Go and TS services; boot fails
      if MySQL unreachable (fail-fast).
- [ ] **Valkey pubsub invalidation** working: admin writes override → all
      processes update within 2 s (verified by integration test).
- [ ] **Admin REST endpoints** for `phone_codes_overrides` (GET/POST/DELETE)
      with `admin:system` RBAC; response shapes as §8.3.
- [ ] **`make tz-debug`** CLI works for ad-hoc operator lookup.
- [ ] **9 Prometheus metrics** registered and emitting (§11).
- [ ] **p99 < 1 ms** for all Tier 1–5 resolve calls; benchmark gate enforced
      in CI.
- [ ] **ResolveBatch(1000) < 2 ms** p99; benchmark gate enforced in CI.
- [ ] **No F02 schema amendments needed** (A1/A4/A5 already in `schema.prisma`).
- [ ] **gRPC `.proto` committed** to `shared/proto/tz.proto` (not deployed
      Phase 1; present for Phase 2).
- [ ] **Coverage ≥ 80%** on `dialer/internal/tz/**` and `api/src/tz/**`.
- [ ] **HANDOFF.md** ships with: downstream consumer guide for C01/D02/E01/T04,
      Phase 4 commercial-data-upgrade runbook, Phase 2 gRPC deployment guide,
      split-state fixture maintenance guide.

---

## 17. Open questions resolved (from RESEARCH §11)

| # | Question | Resolution |
|---|---|---|
| 1 | F02 schema RFC for NPA→NXX? | **RESOLVED — already landed** (A1, A4, A5 in schema.prisma). No amendment needed. |
| 2 | `zip_codes` + `phone_codes_overrides` tables location? | **Global reference tables** (no `tenant_id`); F02 owner approved (schema confirms). |
| 3 | TS library pin? | **`google-libphonenumber@^1.2.x`** (see §5.3). |
| 4 | Go library pin? | **`nyaruka/phonenumbers v1.7.x`** (see §5.3). |
| 5 | Pre-compute ZIP→IANA or runtime polygon? | **Build-time** (Census ZCTA + TBB 2026a); committed as `db/seeds/zip_codes.csv`; no polygon at runtime. |
| 6 | ResolveBatch vs N × Resolve for hopper? | **ResolveBatch** — amortizes parse LRU; goroutine pool; see §8.1. |
| 7 | gRPC Phase 1 or defer? | **Defer to Phase 2** — in-process both sides Phase 1; `.proto` committed for contract lock-in. |
| 8 | Cache invalidation channel name? | **`vici2.phone_codes.invalidate`** (matches F04 Valkey pub/sub convention, same as DNC invalidation pattern). |
| 9 | Mobile flag downgrade — D03 or C01? | **C01 decides.** D03 reports `NumberType`; C01 optionally treats ZIP+MOBILE as medium confidence. |
| 10 | Canada/Caribbean coverage? | **Yes — seed pipeline includes NANP Canada/Caribbean NXXs** (same NANPA data source). C01 gate is US-only; Canadian leads get IANA resolution but are not subject to TCPA quiet-hours (C01 docs). |
| 11 | NANPA scraping ToS/rate limits? | **Polite UA + ≤1 req/s + attribution in README.** Same approach as LCG. NANPA data is public domain; no ToS published. |
| 12 | Bad IANA in `known_timezone` → error or fall-through? | **Fall-through with warning log.** A typo must not block all dials for a lead. |
| 13 | Refresh cadence 6h — too long? | **6h for `phone_codes`** (NXX reassignments are rare); **pubsub for immediate admin overrides** (<1 s propagation); **24h for `zip_codes`** (ZIP boundaries change ~annually). |
| 14 | Phase 1 UI for `phone_codes_overrides`? | **Admin REST API + `make tz-debug` CLI** (Phase 1 placeholder). M03 admin UI for overrides is Phase 2. |
| 15 | Mobile flag → ZIP confidence auto-downgrade? | **D03 reports; C01 decides** (Q9 above). No D03 code change. |

---

## 18. Dependencies and risks

### 18.1 Hard dependencies (must be DONE before D03 IMPLEMENT)

| Dependency | What D03 needs | Status |
|---|---|---|
| **F02 schema (A1, A4, A5)** | `phone_codes`, `zip_codes`, `phone_codes_overrides` tables | **LANDED** (schema.prisma commit `5943a1e`) |
| **F04 PLAN** | Valkey pubsub channel convention; `vici2.phone_codes.invalidate` | PLAN |
| **F05 PLAN** | `requirePermission('admin:system')` for override endpoints; AsyncLocalStorage (N/A for global reference tables) | PLAN |
| **C01 PLAN** | Confidence enum contract (C01 is the primary consumer) | **PLAN LANDED** — enum confirmed in §3 |

### 18.2 Soft dependencies (can implement with stubs)

| Module | Dependency nature |
|---|---|
| **E01** | Calls `ResolveBatch`; can develop against in-process stub returning NONE |
| **D02** | Calls `resolveBatch` (TS) per-batch; can stub for import pipeline development |
| **T04** | Calls `Resolve` at originate time; can stub returning ALLOW |
| **A04** | Calls TS `resolveTimezone`; can stub for manual-dial UX development |
| **M03** | Phase 2 UI for override management; admin API (§8.3) is the Phase 1 interface |

### 18.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LCG rate-limits build script | Low | Medium | ≤1 req/s; cache responses; LCG has been community-stable for 15+ years. Fallback: last committed CSV always valid. |
| NANPA changes report URL/format | Medium | Medium | Cron failure alert (`make build-phone-codes` exit code 1); build script version-pins the URL format + validates column headers. |
| New NXX assigned in a split state not yet in seed | Medium | High | Tier 4 NPA fallback fires; `vici2_tz_split_state_collisions_total` alert fires at >100/day; admin can add override immediately via REST. Quarterly seed refresh picks it up. |
| Indiana 8-zone complexity — wrong county-FIPS crosswalk | Low | High | `split_state_counties.csv` is hand-curated from DOT 49 CFR Part 71 and verified against IANA `zone1970.tab`. Ship-blocking fixture tests catch regressions. |
| `nyaruka/phonenumbers` metadata lag (phone released after quarterly update) | Low | Low | Tier 3 miss → Tier 4 libphonenumber fires anyway; NPA-level is still legally defensible. |
| `phonenumbers.Parse` panic on malformed input | Low | Medium | Wrapped in `recover()` in `parse.go`; result `NONE` + metric; lead blocked by C01. |
| Valkey down + periodic refresh missed (6h window) | Low | Low | Hot-path is fully in-process; Valkey outage only delays cache updates. Alert on `phone_codes_age_seconds > 86400`. |
| Boot failure on MySQL unreachable | Low | High | Intentional fail-fast (correctness > availability during startup). systemd restart loop; MySQL HA covers the underlying risk. |
| `google-libphonenumber` npm package trust | Low | Medium | 2.5M weekly downloads; direct Google provenance; npm lockfile pins exact hash. |
| Split-state fixture NXX values change (NANPA reassigns) | Low | Low | Fixtures use real NXX values from NANPA data; quarterly seed rebuild catches changes; fixture file updated with seed rebuild and reviewed in PR. |

---

End of PLAN.md.
