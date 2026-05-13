# D03 — Phone-Code Timezone Resolver — RESEARCH

**Module:** D03 (Resolves a US/Canada phone number → IANA timezone for the called party)
**Status:** RESEARCH (blocked on F02 schema; consumed by C01, E01, E02, A04, T04)
**Date:** 2026-05-06
**Working scope:** NANP (US + Canada + Caribbean territories). Phase 1 must cover US 50 states + DC + PR/VI/GU/MP/AS.

> **Stakes.** D03 is the input to C01 (TCPA quiet-hours gate). A wrong timezone =
> illegal call = $500/$1,500 statutory damages per call. C01 has already done the
> compliance/legal research; D03 must give C01 a *correct, defensible, fast,
> auditable* timezone for any phone number the dialer will originate. C01's research
> is the source of truth for **what** windows we enforce; D03's research is about
> **how** we get the IANA timezone string in front of C01 with measurable
> confidence in <1ms, and what happens when each input source is missing.

---

## 1. Executive summary (10 bullets)

1. **The "phone code" name is a misnomer.** Phone-derived TZ is the *third* tier of resolution, not the first. The 4-tier algorithm (`lead.known_timezone` → `lead.zip` → `phone.NPA-NXX` → `lead.state` → `campaign.default` → ERROR) is required because **40%+ of US adults port their cell across tz boundaries** (per FCC LNP studies). Treating the phone number as authoritative is the bug Vicidial inherited and a documented driver of TCPA class actions (Bernal v. Mixtiles, S.D.N.Y. 2025).

2. **F02's current `phone_codes` schema is NPA-only and INSUFFICIENT.** F02/PLAN.md §4.15 defines `phone_codes(area_code CHAR(3) PK, state, country, tz_name, tz_offset_min)` — ~800 rows. **Eight US states** (IN, KY, TN, FL, ID, OR, ND, SD, NE) have NXX-level tz splits within a single NPA. NPA-only resolution mis-times calls in those states. **D03 PLAN must propose an F02 schema RFC** to extend `phone_codes` to NXX granularity (PK becomes `(npa CHAR(3), nxx CHAR(3))`, ~165k rows, ~5MB on-disk — still trivially cacheable).

3. **Canonical lookup library: `github.com/nyaruka/phonenumbers` (MIT, v1.7.x, 2026-04 metadata).** Battle-tested Go port of Google's libphonenumber. Use it for **E.164 parsing, validation, NPA/NXX extraction, and number-type classification** (mobile vs. landline). Its built-in `GetTimezonesForNumber()` is **NPA-granular only** for NANP — same gap as libphonenumber Java — so we **do not use it as the primary tz source**, only as a sanity-check / fallback.

4. **Recommended primary data source: NANPA Central Office Code Utilized Report (free, monthly) joined with rate-center data from Local Calling Guide (`localcallingguide.com/xmlprefix.php`, free XML API).** NANPA gives us authoritative NPA-NXX-state assignments; LCG fills in rate-center / locality which lets us crosswalk to county FIPS → IANA tz via a curated split-state table. Backstop with `djbelieny/geoinfo-dataset` (MIT, NPA-NXX+ZIP+TZ aggregation) for initial seed; refresh quarterly. **Commercial alternative** (NALENND®/NPANXXSource): $50–500/yr, includes IANA `OLSON` column directly — recommend Phase 4 hardening upgrade if litigation risk profile warrants.

5. **IANA name returned, never numeric offset.** Vicidial's `tz_offset_min` (signed minutes) is a DST foot-gun. We return strings like `America/New_York`, `America/Indiana/Indianapolis`, `America/Phoenix`, `Pacific/Honolulu`. Go's `time.LoadLocation` and Node's Luxon `setZone()` both consume IANA names directly with full DST handling. F02 PLAN already adds `leads.known_timezone VARCHAR(40)` for this; we keep `leads.tz_offset_min` only as a derived display field (not authoritative).

6. **Cache strategy: full in-process preload + Valkey pub/sub invalidation.** Phone-codes table at NXX granularity is ~165k rows × ~120 bytes ≈ **20MB**. That fits in any service's RAM and gives **~50ns lookup** (Go map). Both Go dialer and Node API preload at startup from MySQL, refresh every 6h, and listen on Valkey pub/sub channel `vici2.phone_codes.invalidate` for ad-hoc updates (admin override). Fall back to Valkey HASH `phone_codes:{npa}{nxx}` only if process-RAM preload is disabled (compliance-mode flag for tiny edge deployments). **No Valkey GET on hot path** — process map is the contract.

7. **Lead-level `known_timezone` is the most defensible signal.** Set during (a) D02 CSV import if column present, (b) agent UI "I'm in Phoenix" (A05), (c) external CRM webhook (N01). Persisted to `leads.known_timezone` (F02 §4.13 line 512). When present, **always wins** over phone/zip/state — D03 short-circuits at tier 1.

8. **API surface: identical contract on Go and TS sides via shared gRPC.** Go primary: `dialer/internal/tz.Resolve(ctx, ResolveRequest) (ResolveResult, error)`. TS mirror: `api/src/tz/resolve.ts` exporting `resolveTimezone(input): Promise<ResolveResult>`. Both consumed by C01's `assertCallWindow`. Behind the scenes both call the same in-process map; Go is the canonical implementation, Node mirrors it for manual-dial UX (A04). gRPC `tz.proto` `TimezoneService.Resolve(LeadRef) → TimezoneResult` provides cross-language contract; Phase 1 manual-dial may call directly in-process.

9. **Confidence enum is a downstream contract, not an internal detail.** `KNOWN | ZIP | NXX | NPA | STATE_DEFAULT | CAMPAIGN_DEFAULT | NONE`. C01 uses confidence to decide BLOCK vs ALLOW_WARN under `campaign.unknown_tz_policy`. Audit log (C01 §8.1 `call_window_audit.tz_confidence`) records it on every dial. **Confidence is the legal defense package** — it's what we hand to a TCPA plaintiff's counsel to demonstrate reasonable methods.

10. **Performance target: p99 <1ms, p50 <100µs, with zero allocations on hot path.** Achieved by (a) in-process map keyed `uint32(npa*1000+nxx)`, (b) pre-computed `*time.Location` pointers cached per IANA name (avoids `time.LoadLocation` cost per call), (c) `phonenumbers.Parse` only for E.164 numbers entering the system; cache parse result if same number hit twice within 60s. `vici2_tz_resolve_duration_seconds` Prometheus histogram with `{tier, confidence, source}` labels. SLO: p99 <1ms over 24h, alert at 2ms.

---

## 2. Data source decision matrix

> All sources surveyed for: granularity (NPA vs NXX), licensing (commercial use), update cadence, accuracy on the eight split states, and integration complexity. Phase 1 picks one **primary** + one **enrichment** + one **fallback**.

| # | Source | Granularity | License | Cost | Update cadence | Returns IANA? | Pros | Cons | D03 role |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **NANPA Central Office Code Utilized Report** ([nanpa.com/reports/co-code-reports](https://www.nanpa.com/reports/co-code-reports)) | NXX | Free, public domain | $0 | Real-time / daily / monthly | No (no TZ field; gives NPA, NXX, state, OCN, rate-center name) | Authoritative; legally defensible "we used the Numbering Plan Administrator's data" | No TZ column — must crosswalk via state + rate-center → county FIPS → IANA | **PRIMARY** authority for NPA-NXX-state |
| 2 | **NANPA Thousands-Block Report** ([nanpa.com/reports/thousands-block-reports](https://www.nanpa.com/reports/thousands-block-reports)) | NXX-X (1k block) | Free | $0 | Real-time | No | Tracks pooling (carrier-level NXX-X allocation) | Phase 4 enhancement; NXX-level is sufficient Phase 1 | Future: enables N06 reassigned-numbers crosswalk |
| 3 | **Local Calling Guide XML API** (`lcg1.voipmuch.com/xmlquery.php` / `localcallingguide.com/xmlprefix.php`) | NXX + thousands-block | Free, scrapable; no formal TOS | $0 | Daily | No (gives `region` = state, `rc` = rate centre, `lata`, `switch`, `ocn`) | NXX-granular rate-center names; LATA codes; community-maintained for decades | No formal commercial-use grant (use politely, cache aggressively) | **ENRICHMENT** for split states — joins NPA-NXX → rate-center → county |
| 4 | **libphonenumber `PhoneNumberToTimeZonesMapper` (via nyaruka/phonenumbers Go port)** | NPA only for NANP | MIT | $0 | Quarterly w/ libphonenumber metadata releases | Yes (CLDR canonical IDs) | Battle-tested, embedded in binary, Signal-Server uses it; one function call | NPA-granular only — misses Indiana / 7 other split states (the highest-risk gap) | **FALLBACK** when primary lookup misses; sanity-check cross-validation |
| 5 | **`djbelieny/geoinfo-dataset`** (GitHub, MIT) | NPA-NXX + ZIP + city | MIT | $0 | Stale (last update 2018) | No (`gmtOffset` int + `dstObserved` flag) | One CSV with NPA-NXX-ZIP-TZ all joined; great for initial seed | Stale; uses fixed offset not IANA; Canada-heavy | **SEED** for initial Phase 1 ingest; deprecated after first NANPA refresh |
| 6 | **NALENND® Rate Center Edition** ([quentinsagerconsulting.com/npa-nxx-rate-center.htm](https://www.quentinsagerconsulting.com/npa-nxx-rate-center.htm)) | NXX-X (1k block) | Commercial | ~$300/yr | Monthly | **Yes** — `OLSON` column is IANA name directly | Includes `OLSON`, `UTC`, `DST`, county FIPS, ZIP, lat/lon — one-stop shop; CSV format ships with SQL DDL | $$; vendor lock | **Phase 4 hardening** — recommended commercial upgrade once revenue justifies |
| 7 | **NPANXXSource Rate Center Edition** ([npanxxsource.com/npanxx-rate-center.htm](http://npanxxsource.com/npanxx-rate-center.htm)) | NXX-X | Commercial | ~$50–500/yr | Monthly | Implicit (UTC offset + DST flag, not IANA name) | Cheaper; includes carrier OCN | Same as above; less complete | Alternative to NALENND |
| 8 | **`ravisorg/Area-Code-Geolocation-Database`** (GitHub) | NPA only | Public domain (claimed) | $0 | Sporadic | No (lat/lon only; tz inferred) | Easy to consume CSV | NPA-only; no IANA | Reference only |
| 9 | **`ofekray/phone-to-timezone`** (npm) | NPA-NXX prefix trie | MIT | $0 | Author-maintained | Yes | TypeScript-friendly, trie lookup | Underlying data provenance unclear; one-author project | Potential TS implementation reference |
| 10 | **GeoScrub API** ([dncscrub.com](https://docs.dncscrub.com/api-reference/geoscrub/overview)) | Real-time | Commercial | Pay-per-call | Live | Yes | TCPA-aware; bundles state-rules | External RTT in hot path; cost; ToS risk | Out of scope; cite as "vendor reference impl" |
| 11 | **NIST/Census ZCTA Gazetteer** ([census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html)) | ZIP (ZCTA5) → centroid lat/lon | Public domain | $0 | Annual | No (centroid lat/lon; tz inferred via timezone-boundary-builder polygon-in-point) | Authoritative ZIP→county; Census; trivially redistributable | Heavy: requires GIS join with `evansiroky/timezone-boundary-builder` polygons | **PRIMARY** for ZIP → tz crosswalk (tier 2 of resolver) |
| 12 | **`evansiroky/timezone-boundary-builder`** (latest 2026a, IANA tzdata + OSM polygons) | Lat/lon → IANA polygon | ODbL (data) + MIT (code) | $0 | ~2× yr w/ tzdata | **Yes** | Authoritative GeoJSON polygons of every IANA tz; ODbL allows attribution-only redistribution | Polygons are 50MB+; we precompute ZIP → tz at build time (not at runtime) | **BUILD-TIME** to generate `zip_codes` table |
| 13 | **IANA tzdata** ([iana.org/time-zones](https://www.iana.org/time-zones)) | IANA names + DST rules | Public domain | $0 | ~6×/yr | **Yes** | Canonical source for DST rules | Already shipped with Go runtime / Node Intl | Implicit dep; pin tzdata version in Dockerfile |

### Decision (Phase 1)

**Primary tz data path** (resolver tier 3, NPA-NXX):

```
NANPA CO-Code Utilized Report (NPA-NXX-state)
  + Local Calling Guide xmlprefix (NXX rate-center)
  + curated split-state county→IANA crosswalk (D03 ships in repo)
  + djbelieny/geoinfo-dataset (initial seed, retired after first NANPA refresh)
  ──────────────────────────────────────────────
  → phone_codes table (~165k rows, NPA+NXX PK, IANA tz_name)
```

**ZIP path** (resolver tier 2):

```
Census ZCTA Gazetteer (ZIP centroid lat/lon)
  + timezone-boundary-builder polygons (point-in-polygon at build time)
  ──────────────────────────────────────────────
  → zip_codes table (~33k US ZIPs, IANA tz_name)
```

**Library path** (parsing + tier 4 fallback):

```
github.com/nyaruka/phonenumbers v1.7.x
  → Parse, ValidateLength, GetNumberType (mobile vs landline), GetTimezonesForNumber
  (used as last-resort safety net + cross-validation, never primary)
```

**Rejected for Phase 1:** NALENND/NPANXXSource (commercial, defer to Phase 4); GeoScrub (external RTT in hot path); pure libphonenumber (NPA-only granularity).

---

## 3. Lookup algorithm — the 6-tier cascade

> The C01 RESEARCH already specced a 4-tier algorithm at C01 §5.2. D03 is the
> implementation of that cascade plus two additional tiers (state default,
> campaign default) that C01 hands off to D03. Tiers 1–6 below match the spec
> in this module's task description.

### 3.1 Tier table

| Tier | Source | Confidence | Latency budget | When used |
|---|---|---|---|---|
| **1** | `lead.known_timezone` (IANA string in `leads` row) | `KNOWN` | ~50ns | Always check first |
| **2** | `lead.zip` → `zip_codes` lookup → IANA | `ZIP` | <100µs (in-mem map) | When tier 1 missing AND `lead.zip` present AND ZIP is US-format (5- or 9-digit) |
| **3** | `phone.NPA + phone.NXX` → `phone_codes` lookup → IANA | `NXX` | <100µs (in-mem map) | When tiers 1–2 miss; phone parses to NANP E.164 |
| **4** | `phone.NPA` only → `phone_codes` collapse OR `phonenumbers.GetTimezonesForNumber` → IANA | `NPA` | <100µs in-mem; ~5µs library | When tier 3 misses (NXX not yet in our table — new NXX assignment) |
| **5** | `lead.state` → static state→IANA map (single-tz states only) | `STATE_DEFAULT` | ~50ns | When tiers 1–4 miss; only valid for states with one tz (excludes IN, KY, TN, FL, ID, OR, ND, SD, NE) |
| **6** | `campaign.default_timezone` (admin-set fallback) | `CAMPAIGN_DEFAULT` | ~50ns | Last-chance per-campaign default |
| **—** | none | `NONE` | n/a | Returns error; C01 gate decides BLOCK vs ALLOW_WARN per `campaign.unknown_tz_policy` |

### 3.2 Pseudocode (Go canonical)

```go
// dialer/internal/tz/resolve.go
type ResolveRequest struct {
    LeadID         int64           // optional; if 0, lookup from PhoneE164
    PhoneE164      string          // required (any of: "+13175551212" | "13175551212" | parse error → ERR)
    KnownTimezone  string          // optional; pre-loaded from lead.known_timezone
    Zip            string          // optional; pre-loaded from lead.postal_code
    State          string          // optional; 2-letter, pre-loaded from lead.state
    CampaignID     string          // optional; for tier-6 default
}

type Confidence string
const (
    ConfKnown            Confidence = "KNOWN"
    ConfZIP              Confidence = "ZIP"
    ConfNXX              Confidence = "NXX"
    ConfNPA              Confidence = "NPA"
    ConfStateDefault     Confidence = "STATE_DEFAULT"
    ConfCampaignDefault  Confidence = "CAMPAIGN_DEFAULT"
    ConfNone             Confidence = "NONE"
)

type ResolveResult struct {
    IANA          string         // e.g. "America/New_York"; "" if NONE
    Location      *time.Location // pre-loaded; nil if NONE
    Confidence    Confidence
    Source        string         // "lead.known_timezone" | "zip:30024" | "nxx:317-555" | "npa:317" | "state:NY" | "campaign:42" | ""
    NPA           string         // populated when phone parsed
    NXX           string         // populated when phone parsed
    NumberType    NumberType     // MOBILE | FIXED_LINE | UNKNOWN; informational (low ZIP confidence for mobile)
}

func Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error) {
    // Tier 1 — explicit lead override (highest confidence)
    if req.KnownTimezone != "" {
        if loc, ok := lookupLocation(req.KnownTimezone); ok {
            return ResolveResult{IANA: req.KnownTimezone, Location: loc, Confidence: ConfKnown, Source: "lead.known_timezone"}, nil
        }
        // bad IANA string in lead — log, fall through (do not error: agent may have typo'd)
        slog.Warn("invalid lead.known_timezone", "value", req.KnownTimezone, "lead_id", req.LeadID)
    }

    // Parse phone once for tiers 2-6 (extracts NPA, NXX, type)
    parsed, parseErr := parseE164(req.PhoneE164) // wraps phonenumbers.Parse; cached LRU 1k entries
    if parseErr == nil {
        // (parsed.NPA, parsed.NXX, parsed.NumberType available)
    }

    // Tier 2 — ZIP (if present and US format)
    if isValidUSZip(req.Zip) {
        if entry, ok := zipCache.Get(zipKey(req.Zip)); ok {
            return ResolveResult{
                IANA: entry.IANA, Location: entry.Loc, Confidence: ConfZIP,
                Source: "zip:" + req.Zip, NPA: parsed.NPA, NXX: parsed.NXX,
                NumberType: parsed.NumberType,
            }, nil
        }
    }

    if parseErr == nil {
        // Tier 3 — NPA-NXX (the canonical "phone codes" path)
        if entry, ok := phoneCodesCache.Get(npaNxxKey(parsed.NPA, parsed.NXX)); ok {
            return ResolveResult{
                IANA: entry.IANA, Location: entry.Loc, Confidence: ConfNXX,
                Source: "nxx:" + parsed.NPA + "-" + parsed.NXX, NPA: parsed.NPA, NXX: parsed.NXX,
                NumberType: parsed.NumberType,
            }, nil
        }
        // Tier 4 — NPA only (collapse phone_codes by NPA; or libphonenumber)
        if entry, ok := npaOnlyCache.Get(parsed.NPA); ok {
            return ResolveResult{
                IANA: entry.IANA, Location: entry.Loc, Confidence: ConfNPA,
                Source: "npa:" + parsed.NPA, NPA: parsed.NPA, NXX: parsed.NXX,
                NumberType: parsed.NumberType,
            }, nil
        }
        // Library safety net — never returns nothing for a valid NANP number
        if zones, err := phonenumbers.GetTimezonesForNumber(parsed.PhoneNumber); err == nil && len(zones) > 0 {
            iana := zones[0]
            if loc, ok := lookupLocation(iana); ok {
                return ResolveResult{
                    IANA: iana, Location: loc, Confidence: ConfNPA,
                    Source: "npa:libphonenumber:" + parsed.NPA, NPA: parsed.NPA, NXX: parsed.NXX,
                    NumberType: parsed.NumberType,
                }, nil
            }
        }
    }

    // Tier 5 — single-tz state default
    if req.State != "" {
        if iana, ok := singleTzStateMap[req.State]; ok {
            loc, _ := lookupLocation(iana)
            return ResolveResult{
                IANA: iana, Location: loc, Confidence: ConfStateDefault,
                Source: "state:" + req.State, NPA: parsed.NPA, NXX: parsed.NXX,
            }, nil
        }
    }

    // Tier 6 — campaign default (loaded by caller; D03 trusts what it's told)
    if req.CampaignID != "" {
        if iana, ok := campaignDefaultCache.Get(req.CampaignID); ok && iana != "" {
            loc, _ := lookupLocation(iana)
            return ResolveResult{
                IANA: iana, Location: loc, Confidence: ConfCampaignDefault,
                Source: "campaign:" + req.CampaignID,
            }, nil
        }
    }

    // No tier hit — caller (C01) decides BLOCK vs warn
    return ResolveResult{Confidence: ConfNone}, nil
}
```

### 3.3 Algorithmic invariants (test contract)

- **Higher tiers always preempt lower tiers when present.** Test: a lead with `known_timezone=America/Phoenix`, NY state, NY ZIP, and NY area code resolves to `America/Phoenix` (tier 1 wins).
- **Tier 5 is skipped for split states.** `singleTzStateMap` excludes IN, KY, TN, FL, ID, OR, ND, SD, NE — those states never hit tier 5; if tier 3-4 fail for them, fall through to campaign default. Test: lead with `state=IN` and unknown phone → does NOT return Eastern by default; either tier 4 (libphonenumber NPA fallback) or tier 6 / NONE.
- **Tier 4 uses libphonenumber as last resort.** This guarantees we never emit `NONE` for a syntactically valid NANP number. Confidence is `NPA` regardless of route (our table or library).
- **Mobile flag downgrades ZIP confidence in C01's eyes.** D03 reports `NumberType: MOBILE` so C01 may treat tier 2 (ZIP) as MED instead of HIGH for mobile numbers (portability risk). C01 does this filtering, not D03 — D03 only reports.

---

## 4. Cache strategy

### 4.1 Decision: in-process map preload + Valkey invalidation pub/sub

Phone-codes table at NXX granularity is ~165k rows × ~120 bytes ≈ **20MB** in Go's `map[uint32]Entry` representation. A 6h refresh + invalidation channel keeps every service's map fresh. **Valkey is not on the read path.**

| Layer | What | Backing | Lookup | Refresh |
|---|---|---|---|---|
| **L1** (Go) | `phoneCodesCache map[uint32]Entry` (NPA*1000+NXX → Entry{IANA, *Location, NumberType?}) | Process RAM | ~50ns | Preload at boot from MySQL `phone_codes`; 6h periodic; Valkey pub/sub `vici2.phone_codes.invalidate` triggers reload |
| **L1** (Go) | `zipCache map[uint32]Entry` (ZIP int → Entry) | Process RAM | ~50ns | Preload at boot from MySQL `zip_codes`; 24h periodic |
| **L1** (Go) | `singleTzStateMap map[string]string` (state code → IANA) | Compiled-in const | ~50ns | Code constant; ships with binary |
| **L1** (Go) | `locationCache sync.Map[string]*time.Location` | Process RAM | ~50ns hot, ~10µs cold (`time.LoadLocation`) | Lazy-populate on first IANA hit |
| **L1** (Go) | `parsedPhoneLRU` (E.164 → NPA+NXX+type) — `hashicorp/golang-lru/v2` size 4096 | Process RAM | ~200ns | Lazy on parse; LRU eviction |
| **L1** (Node) | Same maps mirrored in `api/src/tz/cache.ts` using plain `Map<string, Entry>` | Process RAM | <1µs | Same preload + Valkey channel |
| **L2** (optional) | Valkey HASH `phone_codes:{npa}{nxx}` → IANA | Valkey | ~200µs RTT | **Off-path**: only used by `make tz-debug` CLI and admin UI ad-hoc queries; not by hot-path resolver |

**Why in-process over Valkey on hot path:**
- E02 pacing tick fires ~3s × N campaigns × ~8 leads = ~30 resolves/s steady; bursts to ~500/s during hopper refill. At 200µs Valkey RTT, that's 100ms/s spent in network. At 100ns map lookup, it's 50µs/s.
- Valkey adds a single point of failure for a deterministic lookup. Phone-codes data is ~20MB; *every* service can hold it.
- Compliance argument: a Valkey outage cannot cause D03 to silently fall back to a wrong tz; map is always present.

**Why Valkey is still in the picture:**
- Pub/sub `vici2.phone_codes.invalidate` channel: when admin edits a `phone_codes` row via M03 admin UI (rare manual override), all services reload within ~1s. Without this we'd wait up to 6h.
- Valkey HASH copy provides admin-side debugging (`HGET phone_codes:317555`) without DB query.

### 4.2 Boot-time preload

```go
// dialer/internal/tz/preload.go
func Preload(ctx context.Context, db *sql.DB) error {
    rows, err := db.QueryContext(ctx, `SELECT npa, nxx, tz_name FROM phone_codes`)
    if err != nil { return err }
    defer rows.Close()
    fresh := make(map[uint32]Entry, 200_000)
    for rows.Next() {
        var npa, nxx, tz string
        if err := rows.Scan(&npa, &nxx, &tz); err != nil { return err }
        loc, err := time.LoadLocation(tz)
        if err != nil { slog.Warn("bad tz in phone_codes", "tz", tz); continue }
        fresh[npaNxxKey(npa, nxx)] = Entry{IANA: tz, Loc: loc}
    }
    phoneCodesCache.Store(&fresh) // atomic.Value[*map]
    metrics.phoneCodesLoaded.Set(float64(len(fresh)))
    return nil
}
```

Boot blocks dialer service until preload succeeds — fail-fast if MySQL is down, since hot-path correctness depends on it.

### 4.3 Invalidation flow

```
admin edits phone_codes row in M03 UI
  → API writes MySQL phone_codes
  → API XPUBLISH vici2.phone_codes.invalidate "<npa><nxx>"
  → all dialer + api processes: SUBSCRIBE → re-fetch row from MySQL → patch in-mem map
  → metric vici2_tz_invalidations_total{reason="admin"} ++
```

For bulk reseed (quarterly NANPA refresh), a single `PUBLISH vici2.phone_codes.invalidate "FULL"` triggers full Preload() in every process.

### 4.4 Memory budget per service

| Cache | Entries | Bytes/entry (est.) | Total |
|---|---|---|---|
| `phoneCodesCache` (NPA-NXX) | ~165k | 120 (uint32 key + Entry pointer + IANA string + Location pointer) | **~20MB** |
| `zipCache` (US ZIPs) | ~33k | 120 | **~4MB** |
| `locationCache` (`*time.Location`) | ~50 distinct | ~5kB each (DST rule tables) | **~250kB** |
| `parsedPhoneLRU` | 4096 | ~200 | **~1MB** |
| `singleTzStateMap` | ~40 | 50 | <2kB |
| **Total per service** | | | **~25MB** |

This is a rounding error compared to FreeSWITCH (300MB+), MySQL buffer pool (512MB), or even Go's runtime baseline (~30MB).

---

## 5. Phone-code data ingestion pipeline

### 5.1 Build script — annual NANPA refresh (Q1)

**Location:** `scripts/build-phone-codes.sh` + `scripts/build-phone-codes.go` (Go program for parsing).

**Annual flow** (cron Jan 15, manual override anytime):

```
1. fetch NANPA Central Office Code Utilized Report (per state, ~50 downloads)
   curl -O 'https://nationalnanpa.com/enas/coCodeReportUnsecured.do?reportType=7&state=$STATE&npa=ALL&format=csv'

2. fetch NANPA Thousands-Block Report (per region, archives at nanpa.com/reports/thousands-block-reports/region)
   wget 'https://nanpa.com/reports/thousands-block-reports/region/<region>.zip'

3. concatenate to one TSV: npa,nxx,state,country,ocn,rate_center

4. for each row, derive IANA tz:
   if state NOT in SPLIT_STATES (8 states): tz = singleTzStateMap[state]
   else: tz = lookupSplitState(state, nxx, rate_center)  // see §6

5. write to db/seeds/phone_codes.csv (committed to repo)

6. Prisma migration consumes CSV at deploy time:
   - DELETE FROM phone_codes WHERE npa=? AND nxx=? for rows that disappeared
   - INSERT ... ON DUPLICATE KEY UPDATE for new+changed rows
   - Keep updated_at for change-tracking
```

### 5.2 Monthly refresh — Local Calling Guide (LCG)

LCG updates daily but a monthly cron is sufficient for tz purposes (NXX rate-center reassignments are rare).

```
1. for each split-state NPA: GET https://localcallingguide.com/xmlprefix.php?npa=$NPA&region=$STATE
   → XML with <prefix><npa><nxx><x><rc><region><lata><switch><ocn>...
2. parse to TSV; merge into db/seeds/lcg_split_states.csv
3. join with NANPA for full row; re-derive IANA tz
4. emit reseed via the same pipeline as §5.1
```

**LCG legality note:** LCG has no published commercial-use license; we cache aggressively, fetch ≤1 req/s, attribute in `db/seeds/README.md`. A polite UA string + caching keeps us on their good side. ThinkTel/ThinkTel.LocalCallingGuide is a published .NET client, suggesting LCG tolerates programmatic use.

### 5.3 Manual override table

`phone_codes_overrides` (separate F02 table — D03 PLAN should propose):

| Column | Type | Notes |
|---|---|---|
| npa | CHAR(3) | PK |
| nxx | CHAR(3) | PK |
| tz_name | VARCHAR(40) | overrides phone_codes.tz_name |
| reason | TEXT | "Customer in Hammond IN ported to PT — verified by support 2026-04-12" |
| created_by | BIGINT FK users.id | |
| created_at, updated_at | DATETIME | |

Lookup order in the resolver: `phone_codes_overrides` LEFT JOIN `phone_codes`, override wins. Loaded into the same in-mem map at boot.

### 5.4 Idempotency

- All seed scripts UPSERT (`INSERT … ON DUPLICATE KEY UPDATE`).
- De-dup key is `(npa, nxx)`; thousands-block X is collapsed to NXX (we don't store at 1k-block granularity Phase 1).
- A rerun of the script with the same input is a no-op (no row touched if nothing changed).
- `db/seeds/phone_codes.csv` is the source of truth; running `make db-seed` is safe at any time.

### 5.5 Pipeline diagram

```
                 ┌──────────────────────────┐
                 │  NANPA CO-Code Util Rpt  │ (annual Q1 cron)
                 │  (free CSV downloads)    │
                 └──────────┬───────────────┘
                            │
                            ▼
                 ┌──────────────────────────┐
   LCG xmlprefix→│ scripts/build-phone-     │←── split-state county→IANA
   (monthly)     │   codes.go               │    crosswalk (committed)
                 │   - dedupe by (NPA,NXX)  │
                 │   - derive IANA tz       │
                 │   - write CSV            │
                 └──────────┬───────────────┘
                            │
                            ▼
                 ┌──────────────────────────┐
                 │  db/seeds/phone_codes.csv│  (committed to git; ~10MB)
                 └──────────┬───────────────┘
                            │
                            ▼ pnpm prisma seed (idempotent)
                 ┌──────────────────────────┐
                 │  MySQL phone_codes       │
                 │  (~165k rows)            │
                 └──────────┬───────────────┘
                            │
                ┌───────────┴─────────────┐
                ▼                         ▼
       ┌────────────────┐        ┌────────────────┐
       │ dialer preload │        │ api preload    │
       │  in-mem map    │        │  in-mem map    │
       └────────────────┘        └────────────────┘
                ▲                         ▲
                └────── Valkey pubsub ────┘
                  vici2.phone_codes.invalidate
```

---

## 6. Indiana / split-state seeding plan

### 6.1 The eight split states

C01 §4.3 enumerated them. Repeated here with **D03 mitigation strategy** column.

| State | Split | NPA(s) involved | D03 mitigation |
|---|---|---|---|
| **IN** | 12 NW+SW counties CT (Lake, Porter, LaPorte, Newton, Jasper, Starke, Pulaski, Gibson, Posey, Vanderburgh, Warrick, Spencer, Perry) + partial (Daviess, Knox, Martin, Pike, Dubois). Rest ET (mostly `America/Indianapolis`). | 219, 260, 317, 463, 574, 765, 812, 930 | Seed every NXX in 219, 574, 765, 812, 930 individually from LCG rate-center; map rate-center → county via county-FIPS table; map county → IANA. |
| **KY** | Western counties CT, eastern ET. Boundary roughly Hardin/LaRue/Green/Adair/Russell line. | 270, 364, 502, 606, 859 | Same per-NXX seeding for 270, 364, 502 (Louisville is ET). |
| **TN** | West (Memphis area, Shelby+15 counties) CT; East ET. | 423, 615, 629, 731, 865, 901, 931 | Per-NXX for 731, 901, 931. |
| **FL** | Panhandle west of Apalachicola River (Gulf+Bay+Calhoun+Holmes+Jackson+Washington+Okaloosa+Santa Rosa+Escambia+Walton) CT. | 850 | Per-NXX for 850. |
| **ID** | Southern PT (10 counties), North MT (rest of NPA 208/986). | 208, 986 | Per-NXX for 208, 986. |
| **OR** | Malheur County MT (`America/Boise`), rest PT. | 458, 503, 541, 971 | Per-NXX for 541. |
| **ND** | Most CT, west MT (Adams, Billings, Bowman, Dunn, Golden Valley, Grant, Hettinger, McKenzie, Mercer, Morton, Sioux, Slope, Stark). | 701 | Per-NXX for 701. |
| **SD** | East CT, west MT (Bennett, Butte, Corson, Custer, Dewey, Fall River, Haakon, Harding, Jackson, Lawrence, Meade, Pennington, Perkins, Shannon, Stanley, Ziebach). | 605 | Per-NXX for 605. |
| **NE** | Most CT, west MT (panhandle counties roughly west of 100°W: Cheyenne, Banner, Box Butte, Dawes, Garden, Kimball, Morrill, Scotts Bluff, Sheridan, Sioux). | 308, 402, 531 | Per-NXX for 308. |

### 6.2 The county→IANA crosswalk

D03 ships a static file `db/seeds/split_state_counties.csv` with columns:

```
state,county_name,county_fips,iana_tz
IN,Lake,18089,America/Chicago
IN,Marion,18097,America/Indiana/Indianapolis
IN,Crawford,18025,America/Indiana/Marengo  -- IN has 5 distinct America/Indiana/* zones
IN,Daviess,18027,America/Indiana/Indianapolis
...
```

Source: DOT 49 CFR Part 71 boundary description + IANA tzdata zone1970.tab.
Note Indiana has **5 IANA zones**: `America/Indiana/Indianapolis`, `America/Indiana/Knox`, `America/Indiana/Marengo`, `America/Indiana/Petersburg`, `America/Indiana/Tell_City`, `America/Indiana/Vevay`, `America/Indiana/Vincennes`, `America/Indiana/Winamac`. **Don't simplify to `America/Chicago` / `America/New_York`** — IANA has historical DST exceptions for these counties.

### 6.3 Build-time join

```python
# inside scripts/build-phone-codes.go (Go pseudo)

for nxx in lcg_nxx_for_split_state(state):
    rc = lcg.rate_center_for(npa, nxx)
    county_fips = rate_center_to_county[rc]  # static lookup; LCG rate-center names are stable
    iana = split_state_county_iana[(state, county_fips)]
    emit(npa, nxx, state, "US", iana)
```

### 6.4 Test fixtures (the 8 must be in unit tests)

| State | Phone | Expected IANA | Notes |
|---|---|---|---|
| IN | +12199335555 (Hammond, Lake County) | America/Chicago | Tier 3 NXX hit |
| IN | +13175551212 (Indianapolis) | America/Indiana/Indianapolis | Tier 3 NXX hit |
| IN | +18125550000 (Tell City, Perry County) | America/Indiana/Tell_City | DST-historical edge |
| KY | +12705551212 (Paducah, McCracken County) | America/Chicago | CT side |
| KY | +18595551212 (Lexington, Fayette County) | America/New_York | ET side |
| TN | +19015551212 (Memphis) | America/Chicago | West TN |
| TN | +18655551212 (Knoxville) | America/New_York | East TN |
| FL | +18505551212 NXX in Pensacola | America/Chicago | Panhandle |
| FL | +18505551212 NXX in Tallahassee | America/New_York | Same NPA, different NXX |
| ID | +12085551212 (Boise) | America/Boise | MT? PT? — verify per-NXX |
| OR | +15415551212 NXX in Ontario, Malheur Co | America/Boise | MT Malheur |
| OR | +15415551212 NXX in Bend | America/Los_Angeles | PT rest of NPA |
| ND | +17015551212 NXX in Fargo | America/Chicago | CT |
| ND | +17015551212 NXX in Dickinson | America/Denver | MT |
| SD | +16055551212 NXX in Sioux Falls | America/Chicago | CT |
| SD | +16055551212 NXX in Rapid City | America/Denver | MT |
| NE | +13085551212 NXX in Scottsbluff | America/Denver | MT panhandle |
| NE | +14025551212 NXX in Omaha | America/Chicago | CT main |

Build script regression: for each fixture, after rebuild, assert lookup returns expected IANA.

---

## 7. Confidence-scoring schema (consumed by C01)

### 7.1 Enum values + stability contract

The seven values are **frozen** after PLAN approval — they are public interface to C01, M08 reports, and `call_window_audit.tz_confidence` ENUM column.

```go
// dialer/internal/tz/confidence.go (frozen)
type Confidence string
const (
    ConfKnown            Confidence = "KNOWN"             // lead.known_timezone (highest)
    ConfZIP              Confidence = "ZIP"               // ZIP centroid → IANA
    ConfNXX              Confidence = "NXX"               // NPA+NXX phone_codes hit
    ConfNPA              Confidence = "NPA"               // NPA-only fallback (libphonenumber or our table)
    ConfStateDefault     Confidence = "STATE_DEFAULT"     // single-tz state (no IN/KY/TN/etc.)
    ConfCampaignDefault  Confidence = "CAMPAIGN_DEFAULT"  // admin-set campaign default
    ConfNone             Confidence = "NONE"              // unresolvable; caller decides BLOCK vs warn
)
```

### 7.2 Confidence by tier

Already in §3.1 table. Restated for cross-ref.

### 7.3 Defensibility ranking (for C01 decision-making)

| Confidence | Legal defensibility | C01 should treat as |
|---|---|---|
| KNOWN | **High** — explicit lead-stated location | ALLOW per gate |
| ZIP (landline) | **High** — physical address-based | ALLOW per gate |
| ZIP (mobile) | **Medium** — ZIP came from CSV/CRM but number is portable | ALLOW per gate; flag for `unknown_tz_policy=warn_on_mobile_zip` (Phase 4 enhancement) |
| NXX | **Medium-High** — best industry-standard for portable numbers | ALLOW per gate |
| NPA | **Medium** — known NPA span tz boundaries (split states) | ALLOW per gate; log warning in audit if state is one of 8 split states |
| STATE_DEFAULT | **Low-Medium** — derived from CRM-recorded state (which may be stale) | ALLOW per gate |
| CAMPAIGN_DEFAULT | **Low** — administrator default; not lead-specific | ALLOW per gate; log "fallback used" |
| NONE | n/a | per `campaign.unknown_tz_policy`: deny (default) or allow_with_warning |

### 7.4 Metrics labels

```
vici2_tz_resolutions_total{tier="1|2|3|4|5|6|none", confidence, source}
vici2_tz_split_state_collisions_total{state, npa}     // tier 4 hit on a split state — alert >100/day
vici2_tz_unknown_total{reason="bad_zip|invalid_phone|no_state|no_default"}
vici2_tz_resolve_duration_seconds{tier}              // histogram; SLO p99 <1ms
```

---

## 8. API surface

### 8.1 Go canonical (`dialer/internal/tz/`)

```go
// dialer/internal/tz/types.go
package tz

type ResolveRequest struct {
    LeadID         int64
    PhoneE164      string  // required; "+13175551212"
    KnownTimezone  string  // optional; IANA from lead.known_timezone
    Zip            string  // optional; lead.postal_code
    State          string  // optional; 2-char US state code
    CampaignID     string  // optional; for tier-6 default
}

type NumberType int
const (
    NumberTypeUnknown NumberType = iota
    NumberTypeFixedLine
    NumberTypeMobile
    NumberTypeFixedOrMobile
    NumberTypeTollFree
    NumberTypePremiumRate
    NumberTypeVoip
)

type ResolveResult struct {
    IANA          string
    Location      *time.Location
    Confidence    Confidence
    Source        string
    NPA, NXX      string
    NumberType    NumberType
}

// Resolver is the package-level singleton; not interface for now (one impl).
type Resolver struct {
    db        *sql.DB
    valkey    *redis.Client  // for invalidation pubsub only, not lookups
    phoneCodes atomic.Value   // *map[uint32]Entry
    zipCodes   atomic.Value   // *map[uint32]Entry
    parsedLRU  *lru.Cache[string, parsed]
    locCache   sync.Map      // string → *time.Location
    // ... other caches
}

func New(db *sql.DB, vk *redis.Client) *Resolver
func (r *Resolver) Preload(ctx context.Context) error
func (r *Resolver) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error)
func (r *Resolver) Subscribe(ctx context.Context) error  // starts pubsub goroutine

// Convenience for the manual-dial / hopper hot path:
func (r *Resolver) ResolveByLeadID(ctx context.Context, leadID int64) (ResolveResult, error)
// (loads lead row, invokes Resolve)
```

**File list (proposed for PLAN):**
- `dialer/internal/tz/types.go` — `ResolveRequest`, `ResolveResult`, `Confidence`, `NumberType`
- `dialer/internal/tz/resolver.go` — main `Resolver` struct + `Resolve()`
- `dialer/internal/tz/preload.go` — boot-time load from MySQL
- `dialer/internal/tz/parse.go` — wraps `phonenumbers.Parse` w/ LRU
- `dialer/internal/tz/states.go` — `singleTzStateMap` (compile-time constant)
- `dialer/internal/tz/locations.go` — `*time.Location` cache
- `dialer/internal/tz/invalidate.go` — Valkey pubsub listener
- `dialer/internal/tz/metrics.go` — Prometheus collectors
- `dialer/internal/tz/resolver_test.go` — table-driven fixture tests
- `dialer/internal/tz/fixtures_test.go` — embedded fixture JSON

### 8.2 TS mirror (`api/src/tz/`)

```typescript
// api/src/tz/types.ts
export type Confidence = 'KNOWN' | 'ZIP' | 'NXX' | 'NPA' | 'STATE_DEFAULT' | 'CAMPAIGN_DEFAULT' | 'NONE';
export type NumberType = 'UNKNOWN' | 'FIXED_LINE' | 'MOBILE' | 'FIXED_OR_MOBILE' | 'TOLL_FREE' | 'PREMIUM_RATE' | 'VOIP';

export interface ResolveRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string;
  zip?: string;
  state?: string;
  campaignId?: string;
}

export interface ResolveResult {
  iana: string;            // '' if NONE
  confidence: Confidence;
  source: string;
  npa?: string;
  nxx?: string;
  numberType?: NumberType;
}

// api/src/tz/resolve.ts
export async function resolveTimezone(req: ResolveRequest): Promise<ResolveResult>;
export async function preload(prisma: PrismaClient, valkey: Redis): Promise<void>;
export function subscribe(valkey: Redis): void;  // attaches pubsub listener
```

**Library choices (TS side):**
- **`google-libphonenumber`** (npm, JS port of libphonenumber, 2.5M weekly downloads) for parsing + NPA-only TZ fallback. Alternatives: `awesome-phonenumber` (smaller, also JS port). Pin in PLAN.
- **`luxon`** for IANA tz arithmetic and DST handling (matches C01's choice, per C01 §4.2).

**File list (proposed for PLAN):**
- `api/src/tz/types.ts`
- `api/src/tz/resolver.ts` — `resolveTimezone()` + tier cascade
- `api/src/tz/preload.ts`
- `api/src/tz/parse.ts` — wraps `google-libphonenumber.PhoneNumberUtil.parse`
- `api/src/tz/states.ts` — `singleTzStateMap` literal
- `api/src/tz/invalidate.ts` — ioredis subscriber
- `api/src/tz/metrics.ts` — `prom-client` collectors (parity with Go)
- `api/src/tz/__tests__/resolver.spec.ts` — vitest table tests
- `api/src/tz/__tests__/fixtures.json` — shared with Go fixtures

### 8.3 Shared gRPC contract (`shared/proto/tz.proto`)

```proto
syntax = "proto3";
package vici2.tz.v1;

service TimezoneService {
  rpc Resolve(ResolveRequest) returns (ResolveResult);
  rpc ResolveBatch(ResolveBatchRequest) returns (ResolveBatchResult);  // for hopper bulk-fill
}

message ResolveRequest {
  int64 lead_id = 1;
  string phone_e164 = 2;
  string known_timezone = 3;
  string zip = 4;
  string state = 5;
  string campaign_id = 6;
}

enum Confidence {
  CONFIDENCE_UNSPECIFIED = 0;
  KNOWN = 1;
  ZIP = 2;
  NXX = 3;
  NPA = 4;
  STATE_DEFAULT = 5;
  CAMPAIGN_DEFAULT = 6;
  NONE = 7;
}

message ResolveResult {
  string iana = 1;
  Confidence confidence = 2;
  string source = 3;
  string npa = 4;
  string nxx = 5;
  string number_type = 6;
}

message ResolveBatchRequest { repeated ResolveRequest requests = 1; }
message ResolveBatchResult  { repeated ResolveResult results = 1; }
```

Phase 1 Node-side resolver runs in-process (no RPC needed). Phase 2 dialer-side may expose gRPC if a separate compliance service emerges; PLAN should decide.

### 8.4 The "phone number was just typed in" path (manual dial UX)

A04 manual dial: agent types `(317) 555-1212`, presses dial. Web → API:

```
POST /api/dial
  { "leadId": 12345, "phoneE164": "+13175551212" }

API hot path (api/src/services/dialer/manual-dial.ts):
  1. lead = prisma.leads.findUnique({ id })
  2. tz = await resolveTimezone({
       phoneE164: "+13175551212",
       knownTimezone: lead.knownTimezone,
       zip: lead.postalCode,
       state: lead.state,
       campaignId: lead.campaignId,
     })
  3. windowDecision = await assertCallWindow(...)  // C01 — uses tz
  4. if ALLOW: gRPC dialer.Originate(...)
```

D03 must complete in <1ms for this UX (otherwise dial-button latency).

---

## 9. Test fixtures (territory + edge cases)

### 9.1 Required fixture set

```json
// dialer/internal/tz/fixtures_test.go (embed)
[
  // === lead.known_timezone (tier 1) overrides everything ===
  {"id":  1, "phone": "+12125551212", "state": "NY", "zip": "10001",
    "known_tz": "America/Phoenix",
    "expect_iana": "America/Phoenix", "expect_conf": "KNOWN",
    "rationale": "tier 1 wins over tier 2-5"},

  // === ZIP (tier 2) overrides phone ===
  {"id":  2, "phone": "+12125551212", "state": "CA", "zip": "90210",
    "expect_iana": "America/Los_Angeles", "expect_conf": "ZIP",
    "rationale": "ported NY number, CA address — ZIP wins"},

  // === Indiana NXX-level splits (the highest-risk) ===
  {"id": 10, "phone": "+12199335555", "state": "IN",
    "expect_iana": "America/Chicago", "expect_conf": "NXX",
    "rationale": "Hammond, Lake County, NW Indiana = CT"},
  {"id": 11, "phone": "+13175551212", "state": "IN",
    "expect_iana": "America/Indiana/Indianapolis", "expect_conf": "NXX",
    "rationale": "Indianapolis = ET (with IANA Indiana zone)"},
  {"id": 12, "phone": "+18125551212", "state": "IN",
    "expect_iana": "America/Indiana/Tell_City", "expect_conf": "NXX",
    "rationale": "Perry County has its own IANA zone (DST history)"},

  // === Hawaii / no DST ===
  {"id": 20, "phone": "+18085551212", "state": "HI",
    "expect_iana": "Pacific/Honolulu", "expect_conf": "NXX"},

  // === Alaska / DST applies ===
  {"id": 21, "phone": "+19075551212", "state": "AK",
    "expect_iana": "America/Anchorage", "expect_conf": "NXX"},

  // === Puerto Rico / no DST ===
  {"id": 22, "phone": "+17875551212", "state": "PR",
    "expect_iana": "America/Puerto_Rico", "expect_conf": "NXX"},
  {"id": 23, "phone": "+19395551212", "state": "PR",
    "expect_iana": "America/Puerto_Rico", "expect_conf": "NXX"},

  // === US Virgin Islands ===
  {"id": 24, "phone": "+13405551212", "state": "VI",
    "expect_iana": "America/St_Thomas", "expect_conf": "NXX",
    "rationale": "USVI shares offset with PR but distinct IANA"},

  // === Guam / Saipan (CNMI) — easy 14h-offset bug ===
  {"id": 25, "phone": "+16715551212", "state": "GU",
    "expect_iana": "Pacific/Guam", "expect_conf": "NXX"},
  {"id": 26, "phone": "+16705551212", "state": "MP",
    "expect_iana": "Pacific/Guam", "expect_conf": "NXX",
    "rationale": "Saipan / CNMI shares Pacific/Guam (ChST UTC+10)"},

  // === American Samoa ===
  {"id": 27, "phone": "+16845551212", "state": "AS",
    "expect_iana": "Pacific/Pago_Pago", "expect_conf": "NXX"},

  // === Arizona — no DST except Navajo Nation ===
  {"id": 30, "phone": "+16025551212", "state": "AZ",
    "expect_iana": "America/Phoenix", "expect_conf": "NXX"},

  // === KY split ===
  {"id": 40, "phone": "+12705551212", "state": "KY",
    "expect_iana": "America/Chicago", "expect_conf": "NXX",
    "rationale": "Paducah CT"},
  {"id": 41, "phone": "+18595551212", "state": "KY",
    "expect_iana": "America/New_York", "expect_conf": "NXX",
    "rationale": "Lexington ET"},

  // === FL panhandle split ===
  {"id": 50, "phone": "+18505551212-PENSACOLA-NXX", "state": "FL",
    "expect_iana": "America/Chicago", "expect_conf": "NXX"},

  // === Number ported, no ZIP, state right ===
  {"id": 60, "phone": "+12125551212", "state": "NY",
    "expect_iana": "America/New_York", "expect_conf": "NXX"},

  // === Tier 4 NPA-only fallback (NXX not in our table) ===
  {"id": 70, "phone": "+19995550000",
    "expect_iana": "", "expect_conf": "NONE",
    "rationale": "NPA 999 invalid — libphonenumber returns empty"},

  // === Tier 5 state default ===
  {"id": 80, "phone": "+19995550000", "state": "CO",
    "expect_iana": "America/Denver", "expect_conf": "STATE_DEFAULT",
    "rationale": "tier 4 misses, CO is single-tz, state wins"},

  // === Tier 5 must NOT fire for split state ===
  {"id": 81, "phone": "+19995550000", "state": "IN",
    "expect_iana": "", "expect_conf": "NONE",
    "rationale": "tier 4 misses, IN is split, tier 5 skipped, no campaign default → NONE"},

  // === Tier 6 campaign default ===
  {"id": 90, "phone": "+19995550000", "campaign_id": "42",
    "campaign_default": "America/Denver",
    "expect_iana": "America/Denver", "expect_conf": "CAMPAIGN_DEFAULT"},

  // === Mobile vs landline (informational) ===
  {"id": 100, "phone": "+13105551212", "expect_number_type": "FIXED_OR_MOBILE",
    "rationale": "US-area-code-based libphonenumber cannot distinguish; informational only"},

  // === Bad input ===
  {"id": 200, "phone": "not-a-phone", "expect_error": "parse_failed"},
  {"id": 201, "phone": "", "expect_error": "empty_phone"},
  {"id": 202, "phone": "+447911123456",  // UK
    "expect_iana": "Europe/London", "expect_conf": "NPA",
    "rationale": "non-NANP number — libphonenumber tier 4 wins; out of normal scope but must not crash"},

  // === Bad IANA in lead.known_timezone ===
  {"id": 210, "phone": "+13175551212", "known_tz": "Mars/Olympus_Mons", "state": "IN",
    "expect_iana": "America/Indiana/Indianapolis", "expect_conf": "NXX",
    "rationale": "fall through to tier 3 when known_tz is invalid; log warning"}
]
```

### 9.2 Property-based tests (Phase 2 hardening)

Add `gopter` (Go) and `fast-check` (TS) for:
- For every randomly-generated US E.164 in NPAs we've seeded: result is non-empty IANA.
- For every (random ZIP that exists in zip_codes): result IANA is consistent with US-mainland tz set (no `Asia/*`).
- For known_tz=`<random valid IANA>`: result equals that IANA (tier-1 invariant).

### 9.3 Performance benchmark

```go
// dialer/internal/tz/resolver_bench_test.go
func BenchmarkResolveTier1_KnownTz(b *testing.B)  // expect ~100ns
func BenchmarkResolveTier3_NXX(b *testing.B)      // expect ~500ns including parse
func BenchmarkResolveTier4_LibphoneFallback(b *testing.B) // expect ~5µs
func BenchmarkResolveBatch1000(b *testing.B)      // hopper-fill batch; expect ~500µs total
```

CI gates on regression: p99 must stay <1ms; benchmark fail blocks PR.

---

## 10. Performance plan (<1ms p99)

### 10.1 Latency budget per tier

| Tier | Hot-path operations | Budget | Measured (target) |
|---|---|---|---|
| 1 (known_tz) | string compare + `time.LoadLocation` cache hit | 200ns | ~100ns |
| 2 (ZIP) | string→uint32 + `map.Get` + Location cache | 300ns | ~150ns |
| 3 (NXX) | `phonenumbers.Parse` (cached) + map.Get | 1µs | ~500ns |
| 4 (NPA) | same as tier 3 + 1× map.Get | 1µs | ~500ns |
| 5 (state) | string→string map.Get | 100ns | ~50ns |
| 6 (campaign) | map.Get | 100ns | ~50ns |

p99 budget: **1ms total** (allowing for GC pause + L1 cache miss).

### 10.2 Optimizations applied

1. **Parse cache.** `phonenumbers.Parse` is ~5µs; LRU 4096 entries reduces effective cost to ~200ns for hot leads.
2. **Pre-loaded `*time.Location`.** `time.LoadLocation("America/New_York")` is ~10µs first time (reads tzdata file). We cache pointers in `sync.Map`. After warmup (~50 distinct US tzs), all hits are ~50ns.
3. **Compact map keys.** `uint32(npa*1000+nxx)` instead of string concat — eliminates allocation.
4. **Atomic snapshot pattern.** `phoneCodesCache` is `atomic.Value[*map]`; reads are lock-free. Reload swaps the pointer atomically. No RWMutex contention.
5. **No allocation on cache hit.** `ResolveResult` returned by value (Go); `Source` and `IANA` are interned strings from the cache (no new allocations).
6. **Batch API for hopper.** `ResolveBatch` resolves 1000 leads in one call; amortizes LRU lookups; targets <500µs end-to-end.

### 10.3 Profiling plan

Required Prometheus metrics:
```
vici2_tz_resolve_duration_seconds{tier}    histogram (buckets: 100ns, 1µs, 10µs, 100µs, 1ms, 10ms)
vici2_tz_resolve_total{confidence, source}  counter
vici2_tz_cache_size{cache="phone_codes|zip|loc|parse"} gauge
vici2_tz_cache_hits_total{cache} counter
vici2_tz_cache_misses_total{cache} counter
vici2_tz_invalidations_total{reason="admin|periodic|pubsub"} counter
vici2_tz_phone_codes_loaded gauge        // for monitoring stale data
vici2_tz_phone_codes_age_seconds gauge   // since last preload
```

CI nightly: run `go test -bench` and post results to Grafana via push gateway.

### 10.4 Memory profile

- `phoneCodesCache`: 20MB (steady-state)
- `zipCache`: 4MB
- `parsedPhoneLRU`: 1MB (4096 entries × ~200B)
- `locationCache`: 250kB
- **Total: ~25MB per service**, dwarfed by everything else.

### 10.5 Failure modes + degradation

| Failure | Behavior | Recovery |
|---|---|---|
| MySQL down at boot | Service refuses to start (fail-fast) | systemd restart loop until MySQL recovers |
| MySQL down at runtime | Cache stays valid; no impact (resolver doesn't hit DB on hot path) | Periodic refresh skipped; alert if `phone_codes_age_seconds > 24h` |
| Valkey down | No invalidation signal; cache may be up to 6h stale | Tolerated; periodic refresh fires anyway |
| `time.LoadLocation` fails for an IANA in our table | Log error, fall through to next tier | Bug in seed data; alert immediately, fix CSV |
| Tier 1-6 all miss → NONE | Return ConfNone; C01 decides (default `unknown_tz_policy=deny`) | No call placed; lead surfaced in M03 admin UI |
| `phonenumbers.Parse` panic | Recovered by middleware; result NONE; metric `vici2_tz_parse_panics_total++` | Library bug — file upstream, deploy patched build |

---

## 11. Open questions for PLAN

1. **F02 schema RFC required.** Current `phone_codes(area_code CHAR(3) PK)` is NPA-only. D03 PLAN must propose an RFC to extend to `(npa CHAR(3), nxx CHAR(3))` PK. Migration:
   - new table `phone_codes_v2(npa, nxx, state, country, tz_name, tz_offset_min)`,
   - keep old `phone_codes` as VIEW on `(npa, MIN(nxx_data))` for backward compatibility?
   - **Decision in PLAN.**
2. **Where do `zip_codes` and `phone_codes_overrides` tables live?** F02 owns global tables. D03 PLAN proposes additions; F02 owner approves before PLAN is signed off.
3. **Library pin for TS side.** `google-libphonenumber` (popular, larger) vs `awesome-phonenumber` (smaller, used by `node-phone-number`). PLAN picks one with version.
4. **Library pin for Go side.** Confirm `nyaruka/phonenumbers v1.7.x`. (`lytics/phonenumbers` is a fork — check if more current.)
5. **Pre-compute ZIP→IANA from polygons or use `geoinfo-dataset` shortcut?** Polygons are technically correct but ~50MB and require GIS dependencies in build pipeline. `geoinfo-dataset` is stale (2018). Recommend: build script uses Census ZCTA centroids + `evansiroky/timezone-boundary-builder` polygon-in-point at build time (executed once per quarter, output checked into repo as `db/seeds/zip_codes.csv`). PLAN confirms.
6. **ResolveBatch vs Resolve for hopper.** E01 hopper-fills 100s of leads/sec. PLAN should specify whether hopper batches its DB query and feeds D03 in batches (cleaner) or calls D03 N times (fine if each is <1µs). Recommend batch.
7. **gRPC vs in-process for Phase 1.** Both Go dialer and Node API need D03. Phase 1: each side runs its own copy (same data, same library). Phase 2: introduce `tz.proto` if cross-language consistency drift becomes a problem. PLAN: defer gRPC.
8. **Cache invalidation channel naming.** Confirm `vici2.phone_codes.invalidate` (D03 PLAN) vs `vici2.cache.phone_codes.invalidate` (F04 cross-cutting convention) — F04 owner sign-off.
9. **Mobile-flag downstream contract.** Should D03's `NumberType: MOBILE` automatically downgrade ZIP confidence from HIGH→MED? Or leave that to C01? Recommend: D03 reports raw `NumberType`; C01 owns the downgrade logic. PLAN confirms.
10. **Canada/Caribbean coverage.** F02 PLAN says ~800 NANP rows including Canada + Caribbean. D03 Phase 1 scope is US per task description. PLAN should specify: do we still seed Canadian NXXs (yes — same pipeline, free) but not run the C01 gate against them (yes — C01 is US TCPA only)? Likely yes-and-yes; PLAN documents.
11. **NANPA scraping ToS / rate limits.** No published ToS; recommend ≤1 req/s, polite UA, attribution in seed README. PLAN may add a fallback "if NANPA refresh fails 3 times, alert ops + fall back to last seed".
12. **What if `lead.known_timezone` is set but is not a valid IANA name?** Pseudocode falls through with a warning. Alternative: bubble error to caller. Recommend fall-through (a typo shouldn't block all dials). PLAN confirms.
13. **Refresh cadence from process map.** 6h periodic + pubsub-triggered. Is 6h too long? For NXX assignments yes (rare); for `phone_codes_overrides` yes (admin override should propagate fast — pubsub handles). PLAN confirms 6h.
14. **Indiana IANA names.** Use `America/Indiana/Indianapolis` and similar specific names, or simplify to `America/New_York` / `America/Chicago`? Recommend specific names — IANA has DST history exceptions for these counties; `America/Indiana/Indianapolis` is the *current* canonical CLDR ID and matches what Go/Node accept. PLAN confirms.
15. **Is there a Phase 1 web UI for editing `phone_codes_overrides`?** Presumably M03 admin UI, but if M03 is on a later schedule, PLAN should specify a `make tz-override` CLI as Phase 1 placeholder.

---

## 12. Citations

### Authoritative numbering data
1. NANPA — Central Office Code Reports. https://www.nanpa.com/reports/co-code-reports
2. NANPA — Thousands-Block Reports by Region. https://www.nanpa.com/reports/thousands-block-reports/region
3. NANPA — Real-time CO Code Utilized Report (per-state interactive). https://nationalnanpa.com/enas/coCodeReportUnsecured.do?reportType=7
4. Local Calling Guide — XML query interface (`xmlprefix.php`). http://lcg1.voipmuch.com/xmlquery.php
5. Local Calling Guide — Prefix list help (column reference). https://localcallingguide.com/prefixhelp.php
6. ralphr123/calling_guide_lookup — open-source LCG scraper (Node). https://github.com/ralphr123/calling_guide_lookup
7. ThinkTel/ThinkTel.LocalCallingGuide — .NET LCG client (proves API tolerance). https://github.com/ThinkTel/ThinkTel.LocalCallingGuide

### Phone-number parsing libraries
8. nyaruka/phonenumbers — Go port of libphonenumber, MIT, v1.7.x (2026-04 metadata). https://github.com/nyaruka/phonenumbers
9. nyaruka/phonenumbers PR #119 — `GetTimezonesForPrefix` slice OOB fix (2022). https://github.com/nyaruka/phonenumbers/pull/119
10. lytics/phonenumbers — fork with bugfixes and metadata regen tooling. https://github.com/lytics/phonenumbers
11. Google libphonenumber — `PhoneNumberToTimeZonesMapper` README. https://github.com/google/libphonenumber/blob/v9.0.28/resources/timezones/README.md
12. printesoi/libphonenumber — alt Go port w/ `GetTimeZonesForRegion`. https://pkg.go.dev/github.com/printesoi/libphonenumber

### Open-source NPA-NXX/ZIP datasets
13. djbelieny/geoinfo-dataset — NPA-NXX + ZIP + tz CSV (MIT, 2018; useful seed). https://github.com/djbelieny/geoinfo-dataset
14. ravisorg/Area-Code-Geolocation-Database — NPA-only with lat/lon (public domain). https://github.com/ravisorg/Area-Code-Geolocation-Database
15. acidvegas/nanpa — Python NANPA API client (2024-12, ISC). https://github.com/acidvegas/nanpa
16. BlueRival/node-areacodes — NPA-only Node lookup. https://github.com/BlueRival/node-areacodes
17. wcg-developers/phone-number-to-timezone — Node area-code → tz, US/Canada. https://github.com/wcg-developers/phone-number-to-timezone
18. ofekray/phone-to-timezone — Node trie-based lookup. https://github.com/ofekray/phone-to-timezone

### Commercial alternatives (Phase 4 reference)
19. NALENND® Rate Center Edition — includes `OLSON` IANA column. https://www.quentinsagerconsulting.com/npa-nxx-rate-center.htm
20. NPANXXSource Rate Center Edition. http://npanxxsource.com/npanxx-rate-center.htm
21. GreatData AC Master — NPA/NXX with TZ + DST flag. https://greatdata.com/pdf/Doc-AreaCodeMaster.pdf
22. GeoScrub API (DNCScrub.com) — TCPA-aware real-time tz/state. https://docs.dncscrub.com/api-reference/geoscrub/overview

### ZIP / GIS data
23. US Census Bureau — ZCTA Gazetteer Files. https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html
24. US Census Bureau — ZCTA Relationship Files. https://census.gov/geographies/reference-files/2020/geo/relationship-files.html
25. evansiroky/timezone-boundary-builder — IANA tz polygons (latest 2026a). https://github.com/evansiroky/timezone-boundary-builder
26. evansiroky/timezone-boundary-builder release 2026a. https://github.com/evansiroky/timezone-boundary-builder/releases/tag/2026a

### Time-zone authority + tooling
27. IANA Time Zone Database. https://www.iana.org/time-zones
28. IANA tz-link (canonical software list). https://www.iana.org/time-zones/repository/tz-link.html
29. DOT 49 CFR Part 71 — Standard time-zone boundaries (IN updates). https://www.federalregister.gov/documents/2006/01/20/06-563/standard-time-zone-boundary-in-the-state-of-indiana
30. Luxon — IANA `setZone` documentation. https://moment.github.io/luxon/api-docs/
31. Luxon — Zones manual (DST handling). https://moment.github.io/luxon/#/zones

### In-process caching
32. hashicorp/golang-lru v2 — thread-safe + `expirable` package. https://github.com/hashicorp/golang-lru
33. golang-lru `expirable` LRU implementation source. https://github.com/hashicorp/golang-lru/blob/main/expirable/expirable_lru.go

### Vicidial reference (so we know what we're improving on)
34. Vicidial AST_VDhopper.pl — uses `vicidial_phone_codes` (NPA-only) + `vicidial_postal_codes`. https://github.com/inktel/Vicidial/blob/master/bin/AST_VDhopper.pl
35. Vicidial ADMIN_area_code_populate.pl — NANPA prefix ingestion (the legacy reference impl). https://github.com/inktel/Vicidial/blob/master/bin/ADMIN_area_code_populate.pl
36. Vicidial forum — postal-code vs area-code TZ resolution bug discussion. https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=42276

### Compliance / litigation context (links into C01)
37. C01 RESEARCH.md — TCPA gate; lots of relevant TZ research. `/root/vici2/spec/modules/C01/RESEARCH.md`
38. F02 PLAN.md §4.13 (`leads.known_timezone`, `leads.tz_offset_min`), §4.15 (`phone_codes`). `/root/vici2/spec/modules/F02/PLAN.md`
39. F04 PLAN.md §3.4 (cache vs state DB split), §4.10–§4.13 (cache patterns). `/root/vici2/spec/modules/F04/PLAN.md`
40. Privacy World — TCPA quiet-hours wave (Mar 2025). https://www.privacyworld.blog/2025/03/new-class-action-threat-tcpa-quiet-hours-and-marketing-messages/

---

## STOP. Do not proceed to PLAN. Awaiting checkpoint review.

### Blocking dependencies before PLAN can proceed
- **F02 schema RFC.** `phone_codes` PK must extend NPA-only → `(npa, nxx)`. Two new tables proposed: `zip_codes` and `phone_codes_overrides`. F02 owner sign-off required before D03 PLAN is final.
- **F04 channel name.** Confirm `vici2.phone_codes.invalidate` Valkey pubsub channel matches F04 naming convention.
- **C01 confidence enum.** Lock the seven-value enum (`KNOWN | ZIP | NXX | NPA | STATE_DEFAULT | CAMPAIGN_DEFAULT | NONE`) as joint contract with C01.

### When unblocked, the PLAN.md should
1. Pin `nyaruka/phonenumbers` v1.7.x (Go) and `google-libphonenumber` (TS) with exact versions.
2. Specify the F02 RFC for `phone_codes` schema extension (NPA→NPA-NXX) with reversible migration.
3. Define `zip_codes` and `phone_codes_overrides` table schemas.
4. Specify the Go file layout under `dialer/internal/tz/`.
5. Specify the TS file layout under `api/src/tz/`.
6. Spec `scripts/build-phone-codes.go` (NANPA + LCG + crosswalk → CSV).
7. Spec `scripts/build-zip-codes.go` (Census ZCTA + timezone-boundary-builder polygon-in-point → CSV).
8. Lock the test fixture set (§9) as ship-blocking.
9. Specify p99 <1ms perf SLO + benchmark gate in CI.
10. Confirm/defer gRPC `tz.proto` (recommend defer; in-process Phase 1).
11. Define metrics names + Prometheus collectors.
12. Define the manual override CLI / admin UI hook for `phone_codes_overrides`.
