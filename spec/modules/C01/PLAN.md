# C01 — Time-Zone Enforcement Gate — PLAN

| Field | Value |
|---|---|
| Track | Compliance (cross-cutting) |
| Phase | 1 |
| Effort | 2 days |
| Owner agent type | backend-go (canonical) + backend-node (mirror) |
| Status | PLAN |
| Depends-on (DONE/PLAN-stable) | D03 (TZ resolver), F02 (`leads.known_timezone`, `leads.postal_code`, `leads.state`, `call_times`) |
| Blocks | E01 (hopper filler), E02 (pacing), T04 (originate gate), C03 (audit immutability), A04/A07 (manual dial UX) |

> **Stakes restated.** $500/$1,500 per illegal call (47 USC §227(b)(3)). 100+ class-action quiet-hours filings in Q1 2025 alone (RESEARCH §11). C01 is *the* technical control that prevents that exposure for vici2 operators. SPEC §4.1 names this an unwaivable hard floor: "8am–9pm called-party-local-time gate (enforced in hopper filler, double-checked at originate)".

---

## 0. TL;DR — 10-bullet decision summary

1. **Canonical implementation lives in Go** (`dialer/internal/compliance/tcpa/`) — gate runs on the same hot path as E01 hopper filler / E02 pacing / T04 originate (all Go). A thin TS mirror (`api/src/compliance/tcpa/`) wraps the same rule matrix for the manual-dial Node entrypoint (A04). The two share the rule data via a code-generated source-of-truth file (see §3).
2. **Federal floor is hard-coded at 08:00–21:00 called-party-local time**, applied unconditionally as the always-on baseline. It cannot be relaxed by any campaign config; campaign configs can only narrow further. Boundary handling: *initiate* must be ≥30 s before `effective.end` so no leg rings past 21:00 local (E02 enforces, C01 reports the boundary).
3. **State exceptions are codified as a Go struct table** (`stateRules map[string]StateRule`) embedded in the binary, generated from a single CSV (`db/seeds/state_rules.csv`) so the same source seeds the TS mirror and `state_holidays` table. Encoding decision: matrix-in-code (see §3.4 for rationale: <70 entries, change cadence quarterly-or-slower, defensibility wins from `git blame`).
4. **TZ resolution is delegated entirely to D03's `Resolve()`** (RESEARCH §8.1). C01 never re-implements the 6-tier cascade. C01 receives `(iana, confidence, source)` and trusts it. For Indiana NXX splits, D03 is the authority — C01 is unaware of NPA-NXX details.
5. **Public API returns a discriminated union**, not throws (RESEARCH §11 Q7 resolved → union). Three outcomes: `ALLOW`, `SKIP_UNTIL { nextOpen }`, `BLOCK_INVALID { reason }`. The TS mirror also exposes an `assertCallWindowOrThrow` adapter for legacy A04 callers that prefer try/catch — same underlying core.
6. **Three enforcement points** (RESEARCH §7): (a) E01 hopper filler — `Check()` per lead before `ZADD`, SKIP_UNTIL routes to `t:{tid}:hopper:delayed:{cid}`; (b) T04 originate path — `Check()` immediately before `bgapi originate`, last-chance gate; (c) E02 pacing loop — `WindowClosesWithin(d)` advisory deprioritization.
7. **No manual-dial override** (RESEARCH §9.7). Manual dial path also calls `Check()`. Plaintiff lawyers subpoena the override; not having one is the cheapest defense. Documented and frozen.
8. **`call_window_audit` table requested as F02 amendment** (§8). One row per `BLOCK_INVALID` and per `SKIP_UNTIL` always; `ALLOW` sampled at 1% (~500/day per 100-agent center). Monthly partitioned, append-only, grants enforced by C03.
9. **Gate-fail-at-originate emits a PAGE-severity metric** `vici2_compliance_tcpa_outside_window_total` consumed by the alert rule O01 PLAN §3.1 already files under "compliance hard floors" — any non-zero rate is a SEV1 page (a number got past the hopper gate but didn't get past the originate gate, meaning the hopper is buggy; if non-zero AND we still dialed, see SEV0 incident-runbook stub in §11).
10. **B2B and EBR exemptions are explicitly NOT honored in Phase 1.** Both stay subject to the gate. Phase 4 may add a `lead.is_business=true` hook only after legal review; tracked as an open issue, not a code path.

---

## 1. Module scope (what's in / what's out)

### 1.1 In scope (this PLAN's deliverable)
- The `Check(ctx, req) → CheckResult` function in Go and TS.
- The federal+state rule matrix, encoded as Go data + CSV seed.
- The boundary-deprioritization helper `WindowClosesWithin(req, d) → bool`.
- The audit-emit hook (writes via the api worker queue; the queue itself is C03/F02 territory).
- The metrics surface (`vici2_compliance_tcpa_*`).
- The rule fixtures + acceptance test catalog (28 cases, RESEARCH §10).
- F02 amendment request: `call_window_audit` table.

### 1.2 Out of scope (handed off to other modules)
- TZ resolution itself → **D03** (`tz.Resolve(ctx, req) → (iana, confidence, …)`).
- `phone_codes`, `zip_codes` schemas + ingestion → **D03 / F02**.
- Frequency caps (FL/OK/MD = 3/24h same subject) → **future C05** (flagged in §13).
- DNC scrub → **D05** (separate gate; runs *before* C01 in E01's order).
- Recording-consent (1-party / 2-party state matrix) → **C02** (separate gate; runs in T04 alongside C01).
- Audit-table immutability + grants + retention → **C03** (consumes the table this PLAN files).
- Audit-table schema row → **F02 amendment** (see §8 below).

### 1.3 What changed vs. RESEARCH

| RESEARCH question | PLAN decision |
|---|---|
| Q1: per-campaign or system-wide unknown-TZ default? | Per-campaign (`campaigns.unknown_tz_policy ENUM('deny','warn_pass') DEFAULT 'deny'`). Filed as part of F02 amendment in §8. |
| Q2: `known_timezone` location | Already on `leads.known_timezone` per F02 PLAN §4.13 — no change needed. |
| Q3: state holidays storage | New `state_holidays` table requested (§8). |
| Q4: Maine autodialer detection | Use existing `campaigns.dial_method` (F02). Express in `StateRule.AutoDialerOnly`. |
| Q5: frequency caps location | Punted to C05 (separate module). C01 only flags the metric. |
| Q6: EIA petition | Phase 1 ignores; gate runs unconditionally. |
| Q7: throw vs union | **Union** (`CheckResult`). TS legacy adapter wraps for try/catch. |
| Q8: caching strategy | None inside C01. D03 owns its caches. C01 is pure-function on `(req, time.Now())`. |
| Q9: gRPC Go↔Node | **Not needed Phase 1** — C01 logic mirrored in both languages from the same CSV. (gRPC adds latency to a hot path that's already a microsecond-class pure-function.) |
| Q10: Go-side local cache | D03 owns it; C01 is stateless. |
| Q11: DST regression suite | In `dialer/internal/compliance/tcpa/dst_regression_test.go`, runs against next 5 years of US DST transitions. |

---

## 2. Public interface

### 2.1 Go canonical (`dialer/internal/compliance/tcpa/`)

```go
// dialer/internal/compliance/tcpa/types.go
package tcpa

type Outcome string
const (
    OutcomeAllow        Outcome = "ALLOW"
    OutcomeSkipUntil    Outcome = "SKIP_UNTIL"
    OutcomeBlockInvalid Outcome = "BLOCK_INVALID"
)

type EnforcementPoint string
const (
    PointHopper    EnforcementPoint = "hopper_filler"
    PointOriginate EnforcementPoint = "originate_path"
    PointPacing    EnforcementPoint = "pacing"
    PointManual    EnforcementPoint = "manual_dial"
)

type CheckRequest struct {
    LeadID            int64
    PhoneE164         string  // canonical, +1NXXXXXXXXX
    KnownTimezone     string  // optional; from leads.known_timezone
    Zip               string  // optional; from leads.postal_code
    State             string  // optional; 2-char US code from leads.state
    CampaignID        int64
    CampaignWindow    *Window  // narrower than fed; nil = no campaign override
    UnknownTzPolicy   UnknownTzPolicy  // 'deny' (default) | 'warn_pass'
    EnforcementPoint  EnforcementPoint
    When              time.Time   // injectable for tests; default time.Now() at caller
    IsAutoDialer      bool        // from campaigns.dial_method; gates ME special window
}

type CheckResult struct {
    Outcome     Outcome
    TzIANA      string                  // "America/New_York"; "" if Outcome==BLOCK_INVALID and reason=no_timezone
    Confidence  tz.Confidence           // KNOWN / ZIP / NXX / NPA / STATE_DEFAULT / CAMPAIGN_DEFAULT / NONE
    NextOpen    *time.Time              // populated iff Outcome==SKIP_UNTIL
    Reason      string                  // human-readable controlled vocab; see §2.4
    RuleApplied string                  // "fed_8_21" | "RI_Sat_10_17" | "LA_Sun_blackout" | "ME_auto_9_17" | …
    PartyLocal  time.Time               // when in TzIANA — for audit
    Effective   Window                  // the intersected window applied (open/close minutes)
}

type Window struct {
    OpenLocal  time.Duration  // minutes since local midnight; e.g., 8*time.Hour
    CloseLocal time.Duration  // minutes since local midnight; e.g., 21*time.Hour
    DowMask    uint8          // bit 0=Sun .. bit 6=Sat; 0 means "all days"
}

type StateRule struct {
    Code             string                   // "FL"
    PerDow           [7]Window                // index 0=Sun..6=Sat; zero-value = no business that day (blackout)
    HolidayBlackout  []HolidayMatcher         // ISO dates + named (Mardi Gras, Good Friday)
    AutoDialerOnly   *Window                  // narrower window for autodialed (ME)
    Comment          string                   // citation snippet for `git blame` / docs
}

type HolidayMatcher struct {
    Kind   string  // "fixed" | "easter_offset" | "named"
    Value  string  // "2026-12-25" | "-2" (Good Friday = Easter-2) | "MARDI_GRAS"
}

type UnknownTzPolicy string
const (
    PolicyDeny     UnknownTzPolicy = "deny"
    PolicyWarnPass UnknownTzPolicy = "warn_pass"
)

// dialer/internal/compliance/tcpa/check.go
func Check(ctx context.Context, req CheckRequest) (CheckResult, error)

// dialer/internal/compliance/tcpa/boundary.go
// Pacing helper: returns true if the called-party local window for `req`
// closes within `d`. Cheap; reuses Check's intersection logic without
// emitting a metric/audit row.
func WindowClosesWithin(ctx context.Context, req CheckRequest, d time.Duration) (bool, error)
```

**Constructor & deps:**

```go
// dialer/internal/compliance/tcpa/checker.go
type Checker struct {
    resolver  *tz.Resolver        // D03; required
    audit     audit.Sink          // §6 — async writer to call_window_audit; nil = stdout dev mode
    rules     map[string]StateRule  // §3
    holidays  *HolidayCalendar    // §3.5
    nowFn     func() time.Time    // overridable for tests
    sampleRate float64            // ALLOW sampling (default 0.01)
    metrics   *metrics            // wraps prometheus collectors
}

func New(opts CheckerOpts) (*Checker, error)
func (c *Checker) Check(ctx context.Context, req CheckRequest) (CheckResult, error)
func (c *Checker) WindowClosesWithin(ctx context.Context, req CheckRequest, d time.Duration) (bool, error)
```

`Checker` is the package-level singleton wired in `dialer/cmd/dialer/main.go` (and `dialer/cmd/eslbridge/main.go` if T04 boundary lands there). The package also exposes `var Default *Checker` set by `New(...)` so package-level `Check()` works for callers that don't want to thread the singleton.

### 2.2 TS mirror (`api/src/compliance/tcpa/`)

```typescript
// api/src/compliance/tcpa/types.ts
export type Outcome = 'ALLOW' | 'SKIP_UNTIL' | 'BLOCK_INVALID';
export type EnforcementPoint = 'hopper_filler' | 'originate_path' | 'pacing' | 'manual_dial';
export type UnknownTzPolicy = 'deny' | 'warn_pass';

export interface CheckRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string;
  zip?: string;
  state?: string;
  campaignId?: bigint;
  campaignWindow?: Window;
  unknownTzPolicy?: UnknownTzPolicy;
  enforcementPoint: EnforcementPoint;
  when?: Date;
  isAutoDialer?: boolean;
}

export interface CheckResult {
  outcome: Outcome;
  tzIana?: string;
  confidence: 'KNOWN' | 'ZIP' | 'NXX' | 'NPA' | 'STATE_DEFAULT' | 'CAMPAIGN_DEFAULT' | 'NONE';
  nextOpen?: Date;
  reason: string;
  ruleApplied: string;
  partyLocal?: Date;
  effective?: Window;
}

// api/src/compliance/tcpa/check.ts
export async function check(req: CheckRequest): Promise<CheckResult>;

// Legacy adapter for A04 manual-dial UX (`C01.md` original signature):
export async function assertCallWindowOrThrow(req: CheckRequest): Promise<void>;
// Throws AppError('OUTSIDE_CALL_WINDOW', { reason, nextOpen, tzIana, ruleApplied }) on non-ALLOW.
```

The TS mirror loads the same `state_rules.json` (compiled from the CSV, see §3.3) and uses **Luxon** for IANA arithmetic + DST. Confidence/source string values come from D03's TS mirror (`api/src/tz/types.ts`) verbatim — the literal-union types must match D03's source-of-truth.

### 2.3 No gRPC in Phase 1

Per §1.3 Q9: both Go and TS use the same matrix and the same algorithm. Round-tripping through gRPC for what is a pure function of `(req, now())` would add a network hop into the pacing-loop hot path for no compliance benefit. If/when the rule set diverges across services in Phase 4, a `compliance.proto` becomes worthwhile; not now.

### 2.4 `Reason` controlled vocabulary

The `Reason` string is a stable enum (not free text) so audit queries and metric labels stay low-cardinality:

```
no_timezone               # D03 returned NONE, policy=deny
unknown_tz_warn_pass      # D03 returned NONE, policy=warn_pass — ALLOW emitted but flagged
state_sunday_blackout     # AL/LA/MS/UT/RI on Sunday
state_holiday_blackout    # AL/LA/RI/UT (or LA Mardi Gras / Good Friday) on a listed holiday
before_window             # local time < effective.OpenLocal
after_window              # local time >= effective.CloseLocal
state_autodialer_window   # ME autodialer outside 9-17 M-F
boundary_30s_to_close     # only emitted at originate point as a hard stop
ok                        # ALLOW path; reason mostly cosmetic
```

A unit test asserts the set is exhaustive (no string outside this set is ever returned). Adding a new reason requires PR + linter update.

---

## 3. Federal + state rule matrix — encoding decision

### 3.1 Decision

**Matrix-in-code (Go struct literal generated from a single CSV).**

```
db/seeds/state_rules.csv   ← source-of-truth (committed)
       │
       ├── go generate `tcpa-rulesgen` →  dialer/internal/compliance/tcpa/rules_gen.go
       │                                  (a `var stateRules = map[string]StateRule{...}`)
       │
       └── pnpm `tcpa-rulesgen-ts`     →  api/src/compliance/tcpa/rules.gen.ts
                                          (a frozen JSON object literal)
```

Both generated files are committed and gated by a CI check that re-runs the generator and `git diff --exit-code`s. Manual edits to `*_gen.*` are forbidden.

### 3.2 Why matrix-in-code (not a database table)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **MySQL `state_rules` table** | Editable in admin UI without redeploy | Tenant-scope confusion (rule is *jurisdictional*, not tenant); "edited at 2:14am by `bob`" is a litigation artifact; cache layer needed in Go hot path | ❌ |
| **JSON config file shipped at runtime** | Easy refresh | Drift between Go and TS; needs file-watcher; deploy-coupled anyway | ❌ |
| **Matrix in Go code, generated from CSV** | Compiles in (no startup cost, no cache, no race); `git blame` shows who/when/why each rule changed; Go and TS stay in lockstep via codegen; PR review is the change-control process | Quarterly rule update → PR + deploy (acceptable; rules change slowly) | ✅ |

The CSV-as-source matters: the TS side gets the same data without forcing Node to import Go code. The CSV also doubles as the data source for the F02 `state_holidays` seed (§8.2).

### 3.3 `db/seeds/state_rules.csv` shape

Columns:
```
state,dow,open_local,close_local,blackout,holiday_kind,holiday_value,autodialer_only,citation,comment
```

Rows (excerpt — full file builds out the matrix in RESEARCH §3):

```csv
# Federal floor — "FED" sentinel; applied in code as the unconditional baseline
FED,*,08:00,21:00,false,,,false,47 CFR 64.1200(c)(1),Federal floor
# 8pm-cutoff states
AL,*,08:00,20:00,false,,,false,Ala. Admin. Code 770-X-5-.17,
CT,*,09:00,20:00,false,,,false,Conn. Gen. Stat. 42-288a(c),9am start + 8pm cutoff
FL,*,08:00,20:00,false,,,false,Fla. Stat. 501.616,FTSA
KY,*,10:00,21:00,false,,,false,KRS 367.46955,Latest start in nation
LA,Mon-Sat,08:00,20:00,false,,,false,La. R.S. 45:844.31,8pm cutoff M-Sat
LA,Sun,,,true,,,false,La. R.S. 45:844.31,Sunday blackout
MD,*,08:00,20:00,false,,,false,Md. Com. Law 14-3201,Stop the Spam Calls Act
MA,*,08:00,20:00,false,,,false,MGL Ch.159C 3,
MS,Mon-Sat,08:00,20:00,false,,,false,Miss. Code Ann. 77-3-723,
MS,Sun,,,true,,,false,Miss. Code Ann. 77-3-723,Sunday blackout
OK,*,08:00,20:00,false,,,false,15 OS 775C.4,OTSA
RI,Mon-Fri,09:00,18:00,false,,,false,R.I. Gen. Laws 5-61-2,Most restrictive M-F
RI,Sat,10:00,17:00,false,,,false,R.I. Gen. Laws 5-61-2,
RI,Sun,,,true,,,false,R.I. Gen. Laws 5-61-2,
WA,*,08:00,20:00,false,,,false,RCW 80.36.390,No B2B exemption
WY,*,08:00,20:00,false,,,false,Wyo. Stat. 40-12-302,
# 9am-start
MI,*,09:00,21:00,false,,,false,MCL 750.540e(f),
MN,*,09:00,21:00,false,,,false,Minn. Stat. 325E.30,
# Sunday-blackout-only (state retains fed window other days)
AL,Sun,,,true,,,false,Ala. Admin. Code 770-X-5-.17,
UT,Sun,,,true,,,false,Utah Code Ann. 13-25a-103,
# State holidays (LA includes Mardi Gras + Good Friday)
AL,*,,,true,fixed,2026-01-01,false,,New Year's Day
AL,*,,,true,fixed,2026-12-25,false,,Christmas
LA,*,,,true,named,MARDI_GRAS,false,La. R.S. 45:844.31,
LA,*,,,true,easter_offset,-2,false,La. R.S. 45:844.31,Good Friday
RI,*,,,true,fixed,2026-12-25,false,R.I. Gen. Laws 5-61-2,
UT,*,,,true,fixed,2026-12-25,false,Utah Code Ann. 13-25a-103,
# Maine autodialer-only special window
ME,Mon-Fri,08:00,21:00,false,,,false,10 M.R.S. 1498,Live calls follow fed
ME,Mon-Fri,09:00,17:00,false,,,true,10 M.R.S. 1498,Autodialer narrower
ME,Sat,08:00,21:00,false,,,false,10 M.R.S. 1498,Live calls follow fed
ME,Sat,,,true,,,true,10 M.R.S. 1498,Autodialer prohibited
ME,Sun,08:00,21:00,false,,,false,10 M.R.S. 1498,Live calls follow fed
ME,Sun,,,true,,,true,10 M.R.S. 1498,Autodialer prohibited
# Texas (TX): 9a-9p Mon-Sat, noon-9p Sun
TX,Mon-Sat,09:00,21:00,false,,,false,Tex. Bus. & Com. Code 301.051,SB 140
TX,Sun,12:00,21:00,false,,,false,Tex. Bus. & Com. Code 301.051,
# Pennsylvania: 8a-9p Mon-Sat, noon-9p Sun
PA,Mon-Sat,08:00,21:00,false,,,false,73 P.S. 2245.4,
PA,Sun,12:00,21:00,false,,,false,73 P.S. 2245.4,
```

(Full encoded set covers all 50 states + DC + PR/USVI/GU/MP/AS. RESEARCH §3 is the canonical source. Any state not listed defaults to federal floor — encoded by the generator inserting an explicit "uses fed" entry so there's no ambiguous absence.)

### 3.4 Generator pseudocode

```
# scripts/build-tcpa-rules/main.go
input:  db/seeds/state_rules.csv
output: dialer/internal/compliance/tcpa/rules_gen.go
        api/src/compliance/tcpa/rules.gen.ts
        db/seeds/state_holidays.sql  (INSERT statements for the table seed)

steps:
  1. parse CSV; collapse multi-row state entries into one StateRule
  2. validate:
        - every state mentioned has either a per-dow window OR fed-fallback marker
        - no row has both a window AND blackout=true
        - holiday_value matches the holiday_kind (date / "MARDI_GRAS" / int offset)
  3. emit Go: gofmt the resulting `var stateRules` literal
  4. emit TS: prettier the resulting JSON literal with `as const` types
  5. emit SQL: `INSERT INTO state_holidays (state, kind, value, name, citation) VALUES ...`
  6. write header `// Code generated by tcpa-rulesgen; DO NOT EDIT.`
```

Run via `go generate ./dialer/internal/compliance/tcpa/...` and `pnpm -F api gen:tcpa-rules`. CI step in `.github/workflows/ci.yml` (gated on the existing `make lint` target).

### 3.5 Holiday calendar (`HolidayCalendar`)

The `HolidayCalendar` type expands holiday matchers into concrete `(state, date)` tuples for the next 5 years at process boot:

```go
type HolidayCalendar struct {
    // map[state] -> set of YYYY-MM-DD in that state's local time
    fixed  map[string]map[string]struct{}
    // recompute() runs at startup and on Jan 1 each year (or via SIGHUP)
}

func (h *HolidayCalendar) IsHoliday(state, dateISO string) bool
```

For LA's Mardi Gras / Good Friday, the generator includes the Easter computus (Anonymous Gregorian algorithm) and emits 5-year-forward dates inline so runtime stays branch-free. The `state_holidays` MySQL table (F02 amendment §8.2) is *also* seeded with the same expanded dates so admin UIs (M03) can render them without re-implementing the computus.

---

## 4. Algorithm — Go pseudocode

(Final pseudocode contract; `check.go` mirrors this 1:1.)

```
func (c *Checker) Check(ctx, req CheckRequest) (CheckResult, error):

    # ─── Step 0: input normalization ───
    if req.When.IsZero(): req.When = c.nowFn()
    if req.UnknownTzPolicy == "": req.UnknownTzPolicy = PolicyDeny

    # ─── Step 1: resolve TZ via D03 ───
    resolved, err = c.resolver.Resolve(ctx, tz.ResolveRequest{
        LeadID: req.LeadID,
        PhoneE164: req.PhoneE164,
        KnownTimezone: req.KnownTimezone,
        Zip: req.Zip,
        State: req.State,
        CampaignID: strconv.FormatInt(req.CampaignID, 10),
    })
    if err != nil: return CheckResult{}, err  # internal error, NOT BLOCK

    if resolved.Confidence == tz.ConfNone:
        if req.UnknownTzPolicy == PolicyWarnPass:
            return c.emit(req, CheckResult{
                Outcome: OutcomeAllow, Confidence: tz.ConfNone,
                Reason: "unknown_tz_warn_pass", RuleApplied: "campaign_warn_pass",
            }), nil
        return c.emit(req, CheckResult{
            Outcome: OutcomeBlockInvalid, Confidence: tz.ConfNone,
            Reason: "no_timezone", RuleApplied: "policy_deny",
        }), nil

    # ─── Step 2: compute called-party local time ───
    loc = resolved.Location           # *time.Location preloaded by D03
    partyLocal = req.When.In(loc)
    dow = int(partyLocal.Weekday())   # 0=Sun..6=Sat
    partyMins = time.Duration(partyLocal.Hour()*60+partyLocal.Minute()) * time.Minute

    # ─── Step 3: pick state for state-rule lookup ───
    # Prefer explicit lead.state; else derive from resolved tz (single-tz-state lookup).
    state = req.State
    if state == "": state = stateFromTz(resolved.IANA)   # e.g., America/New_York → "" (multi-state) → fall through
    rule, hasState := c.rules[state]

    # ─── Step 4: holiday + Sunday blackout (state-only; federal has none) ───
    if hasState:
        if c.holidays.IsHoliday(state, partyLocal.Format("2006-01-02")):
            return c.emit(req, CheckResult{
                Outcome: OutcomeSkipUntil,
                NextOpen: nextBusinessDayOpen(partyLocal, rule, c.holidays),
                TzIANA: resolved.IANA, Confidence: resolved.Confidence,
                PartyLocal: partyLocal,
                Reason: "state_holiday_blackout",
                RuleApplied: state + "_holiday",
            }), nil
        if rule.PerDow[dow].IsBlackout():
            return c.emit(req, CheckResult{
                Outcome: OutcomeSkipUntil,
                NextOpen: nextDowOpen(partyLocal, rule, c.holidays),
                TzIANA: resolved.IANA, Confidence: resolved.Confidence,
                PartyLocal: partyLocal,
                Reason: "state_sunday_blackout" if dow==0 else "state_dow_blackout",
                RuleApplied: state + "_" + dowName(dow) + "_blackout",
            }), nil

    # ─── Step 5: build effective window = intersect(fed, state, campaign[, ME-auto]) ───
    fed = Window{OpenLocal: 8*time.Hour, CloseLocal: 21*time.Hour}
    eff = fed
    if hasState:
        eff = intersect(eff, rule.PerDow[dow])
        if req.IsAutoDialer && rule.AutoDialerOnly != nil:
            eff = intersect(eff, *rule.AutoDialerOnly)
    if req.CampaignWindow != nil:
        eff = intersect(eff, *req.CampaignWindow)

    if eff.OpenLocal >= eff.CloseLocal:
        # state+campaign combined produced empty window for this dow
        return c.emit(req, CheckResult{
            Outcome: OutcomeSkipUntil,
            NextOpen: nextDowOpen(partyLocal, rule, c.holidays),
            TzIANA: resolved.IANA, Confidence: resolved.Confidence,
            PartyLocal: partyLocal,
            Reason: "state_autodialer_window" if req.IsAutoDialer else "after_window",
            RuleApplied: state + "_" + dowName(dow),
        }), nil

    # ─── Step 6: in-window check ───
    if partyMins < eff.OpenLocal:
        return c.emit(req, CheckResult{
            Outcome: OutcomeSkipUntil,
            NextOpen: midnightLocal(partyLocal).Add(eff.OpenLocal),
            TzIANA: resolved.IANA, Confidence: resolved.Confidence,
            PartyLocal: partyLocal, Effective: eff,
            Reason: "before_window",
            RuleApplied: ruleNameOf(state, dow, eff),
        }), nil

    if partyMins >= eff.CloseLocal:
        return c.emit(req, CheckResult{
            Outcome: OutcomeSkipUntil,
            NextOpen: nextDayOpen(partyLocal, rule, eff, c.holidays),
            TzIANA: resolved.IANA, Confidence: resolved.Confidence,
            PartyLocal: partyLocal, Effective: eff,
            Reason: "after_window",
            RuleApplied: ruleNameOf(state, dow, eff),
        }), nil

    # ─── Step 7: ALLOW (originate-point boundary check) ───
    if req.EnforcementPoint == PointOriginate:
        # Stop initiating ≥30s before close so no leg rings past local close
        if eff.CloseLocal - partyMins < 30*time.Second:
            c.metrics.OutsideWindow.Inc()  # PAGE-severity per O01 PLAN
            return c.emit(req, CheckResult{
                Outcome: OutcomeSkipUntil,
                NextOpen: nextDayOpen(partyLocal, rule, eff, c.holidays),
                TzIANA: resolved.IANA, Confidence: resolved.Confidence,
                PartyLocal: partyLocal, Effective: eff,
                Reason: "boundary_30s_to_close",
                RuleApplied: ruleNameOf(state, dow, eff),
            }), nil

    return c.emit(req, CheckResult{
        Outcome: OutcomeAllow,
        TzIANA: resolved.IANA, Confidence: resolved.Confidence,
        PartyLocal: partyLocal, Effective: eff,
        Reason: "ok",
        RuleApplied: ruleNameOf(state, dow, eff),
    }), nil
```

`WindowClosesWithin(req, d)` reuses Steps 1–5 then returns `eff.CloseLocal - partyMins < d` (no audit write, no metric increment except `vici2_compliance_tcpa_boundary_advisory_total`).

### 4.1 Test invariants (the contract)

- **Federal floor never weakens.** Even if `req.CampaignWindow = {06:00, 23:00}`, `eff.OpenLocal == 08:00` and `eff.CloseLocal == 21:00`.
- **Most-restrictive wins.** RI Saturday (10:00–17:00) intersected with campaign 08:00–21:00 → effective 10:00–17:00.
- **Sunday-blackout absorbs the window.** A Sunday in AL never produces ALLOW.
- **DST spring-forward gap.** When `partyLocal` falls in the non-existent 02:00–02:59 hour, Go's `time.Date` normalizes forward to 03:00; we trust that and `partyMins` will land in window. Test fixture covers.
- **DST fall-back ambiguous hour.** Go's `time.Time.In(loc)` selects the second occurrence by default; we accept that (compliance-wise the hour is double-valid). Test fixture covers.
- **`Check(req)` is a pure function modulo `nowFn` and the audit/metric side-effects.** Two calls with identical `req` and identical `nowFn` must return identical `CheckResult`.
- **No reason string outside §2.4 vocabulary.** Linter test.
- **Manual dial path goes through `Check` too.** `EnforcementPoint == PointManual` produces the same outcomes; no override codepath exists.

---

## 5. Three enforcement points — integration contracts

### 5.1 E01 hopper filler (consumer)

**Where:** `dialer/internal/hopper/filler.go`, after DNC scrub stage 5, before ZADD into `t:{tid}:hopper:{cid}`.

**Sequence per candidate lead:**

```
res, err := tcpa.Default.Check(ctx, tcpa.CheckRequest{
    LeadID:           lead.ID,
    PhoneE164:        lead.PhoneE164,
    KnownTimezone:    lead.KnownTimezone,
    Zip:              lead.PostalCode,
    State:            lead.State,
    CampaignID:       campaign.ID,
    CampaignWindow:   campaign.WindowOrNil(),
    UnknownTzPolicy:  campaign.UnknownTzPolicy,
    EnforcementPoint: tcpa.PointHopper,
    IsAutoDialer:     campaign.DialMethod != "manual",
})

switch res.Outcome:
  case OutcomeAllow:
    hopper.ZAdd(...)
  case OutcomeSkipUntil:
    hopper.DelayedZAdd(t:{tid}:hopper:delayed:{cid}, score=res.NextOpen.Unix(), lead.ID)
    metrics.fillerSkipped.WithLabelValues("tcpa_window").Inc()
  case OutcomeBlockInvalid:
    if res.Reason == "no_timezone":
        leads.SetTzBlocked(lead.ID, true)  // surfaces in M03
        metrics.fillerSkipped.WithLabelValues("tcpa_unknown_tz").Inc()
```

**Delayed-set re-injection:** existing E01 filler tick `ZRANGEBYSCORE 0 NOW` against the delayed set, re-evaluating each lead through `Check` again before promoting.

### 5.2 T04 originate path (last-chance gate)

**Where:** `dialer/internal/originate/dial.go` (Go) — `T04.Originate(req LeadOriginateRequest)` wrapper. Per T01 PLAN §16.2, T04 is the policy gate; T01 is pure transport.

**Sequence immediately before `bgapi originate`:**

```
res, err := tcpa.Default.Check(ctx, tcpa.CheckRequest{
    ... // same shape as hopper, but EnforcementPoint = PointOriginate
})

if res.Outcome != OutcomeAllow:
    metrics.outsideWindow.WithLabelValues(string(res.Outcome), res.Reason).Inc()  // PAGE-severity
    audit.WriteOriginateAudit(...)  // T04's existing originate_audit row gets reason=res.Reason
    return ErrOutsideCallWindow{Reason: res.Reason, NextOpen: res.NextOpen}

// proceed to T01.Client.Originate(...)
```

**Why double-check:** lead may have been in hopper for 5+ min and crossed the 21:00 boundary (or a state-strictest 20:00). The hopper was a hint; originate-time is the contract per RESEARCH §7.2.

**On `boundary_30s_to_close`:** treat as hard SKIP at originate (not just advisory). E02 should have stopped sending leads here, but defense-in-depth.

### 5.3 E02 pacing loop (boundary deprioritization)

**Where:** `dialer/internal/pacing/loop.go`, ~3-second tick, deciding how many lines to dial per ready agent.

**Two helpers consumed:**

```go
// 1. For pre-pacing pruning of leads about to expire:
soon, _ := tcpa.Default.WindowClosesWithin(ctx, req, 5*time.Minute)
if soon: deprioritize this lead in the picker

// 2. Hard stop for new originates within 30s of close:
soon30, _ := tcpa.Default.WindowClosesWithin(ctx, req, 30*time.Second)
if soon30: do not initiate new originates for this lead this tick
```

E02's pacing-tick metric `vici2_pacing_boundary_skip_total{reason="tcpa_5min"|"tcpa_30s"}` covers both.

### 5.4 A04 manual dial (Node entrypoint)

**Where:** `api/src/services/dialer/manual-dial.ts`, before the gRPC call into the Go dialer.

```typescript
const res = await tcpa.check({
  phoneE164, leadId, knownTimezone: lead.knownTimezone, zip: lead.postalCode,
  state: lead.state, campaignId: lead.campaignId,
  campaignWindow: campaign.window, unknownTzPolicy: campaign.unknownTzPolicy,
  enforcementPoint: 'manual_dial',
  isAutoDialer: false,
});
if (res.outcome !== 'ALLOW') {
  throw new AppError('OUTSIDE_CALL_WINDOW', {
    reason: res.reason, nextOpen: res.nextOpen, tzIana: res.tzIana,
    ruleApplied: res.ruleApplied,
  });
}
```

T04 still re-checks (defense in depth). The Node check provides the agent-friendly UI error before the round-trip.

### 5.5 Defense-in-depth metric

`vici2_compliance_tcpa_check_total{outcome,reason,enforcement_point,state}` cardinality:
- outcome: 3
- reason: ~10 (controlled vocab §2.4)
- enforcement_point: 4
- state: ~52
≈ 6.2k label combinations max — within O01 PLAN's per-metric cardinality budget.

---

## 6. Audit-log writer (the `audit.Sink` interface)

C01 does not write to MySQL directly. It pushes structured rows onto a Valkey Stream consumed by the api worker:

```go
type Sink interface {
    Write(ctx context.Context, row CallWindowAuditRow) error
}

type CallWindowAuditRow struct {
    Ts                 time.Time
    TenantID           int64
    LeadID             int64
    PhoneE164          string
    CampaignID         int64
    Decision           string  // ALLOW | ALLOW_WARN | SKIP_UNTIL | BLOCK_INVALID
    Reason             string
    TzIANA             string
    TzConfidence       string
    State              string
    Zip                string
    PartyLocal         time.Time
    PartyDow           int
    EffectiveOpenMin   int
    EffectiveCloseMin  int
    RuleApplied        string
    EnforcementPoint   string
    NextOpenAt         *time.Time
    CallUUID           string  // empty until T04 attaches
}
```

**Phase 1 implementation (`StreamSink`):** `XADD t:{tid}:audit:tcpa:stream * <row-json>`. The api worker (lives in `api/workers/audit-flush.ts` — created by C03) consumes with `XREADGROUP`, batches 100 rows, writes one INSERT into `call_window_audit`. Stream MAXLEN ≈ 100k (~2h of full-volume backlog). Dev mode `StdoutSink` is used in tests.

**Sampling rule (RESEARCH §8.3):**
- Always write `BLOCK_INVALID` and `SKIP_UNTIL`.
- Sample `ALLOW` (and `ALLOW_WARN`) at `c.sampleRate` (default 0.01, configurable per-tenant via env/db).
- Sample `WindowClosesWithin` advisory checks at 0% (don't audit; metric is enough).

**Async-not-blocking:** `Sink.Write` returns immediately on success or on stream-full (drop with `vici2_compliance_tcpa_audit_dropped_total` increment). The Check call never blocks on audit. SLO: <100µs added latency at p99.

---

## 7. Metrics surface

```
vici2_compliance_tcpa_check_total{outcome, reason, enforcement_point, state}
   - counter; every Check() invocation
   - outcome ∈ {ALLOW, SKIP_UNTIL, BLOCK_INVALID}

vici2_compliance_tcpa_outside_window_total{enforcement_point, reason, state}
   - counter; non-ALLOW at originate point ONLY (the SEV1 trigger)
   - O01 PLAN §3.1 already files alert: rate>0 over 5m → page

vici2_compliance_tcpa_boundary_advisory_total{kind="5min"|"30s", state}
   - counter; WindowClosesWithin true returns from E02

vici2_compliance_tcpa_check_duration_seconds{enforcement_point}
   - histogram; le buckets {1µs, 10µs, 100µs, 1ms, 10ms}
   - SLO: p99 < 1ms (D03's preloaded cache puts us well inside)

vici2_compliance_tcpa_audit_dropped_total{reason}
   - counter; stream-full drops; reason ∈ {stream_full, sink_error}

vici2_compliance_tcpa_holiday_calendar_age_seconds
   - gauge; seconds since HolidayCalendar last refreshed; alert >36h
```

Cardinality: <8k series across the whole module; well under O01's 100k-per-target budget.

---

## 8. F02 amendment request — `call_window_audit` + supporting columns

This PLAN flags **four** schema additions that F02's IMPLEMENT will need to merge as an addendum migration. Filed as a single coordinated request so F02 batches them.

### 8.1 New table: `call_window_audit`

```sql
CREATE TABLE call_window_audit (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
    tenant_id          BIGINT NOT NULL DEFAULT 1,
    lead_id            BIGINT NOT NULL,
    phone_e164         VARCHAR(16) NOT NULL,
    campaign_id        BIGINT NOT NULL,
    decision           ENUM('ALLOW','ALLOW_WARN','SKIP_UNTIL','BLOCK_INVALID') NOT NULL,
    reason             VARCHAR(64) NOT NULL,
    tz_iana            VARCHAR(40) NULL,
    tz_confidence      ENUM('KNOWN','ZIP','NXX','NPA','STATE_DEFAULT','CAMPAIGN_DEFAULT','NONE') NULL,
    state_code         CHAR(2) NULL,
    zip                VARCHAR(16) NULL,
    party_local        DATETIME(6) NULL,
    party_dow          TINYINT NULL,
    effective_open_min SMALLINT NULL,
    effective_close_min SMALLINT NULL,
    rule_applied       VARCHAR(64) NULL,
    enforcement_point  ENUM('hopper_filler','originate_path','pacing','manual_dial') NOT NULL,
    next_open_at       DATETIME(6) NULL,
    call_uuid          VARCHAR(64) NULL,
    created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_tla              (tenant_id, lead_id, created_at),
    INDEX idx_t_decision_ts    (tenant_id, decision, created_at),
    INDEX idx_t_campaign_ts    (tenant_id, campaign_id, created_at),
    INDEX idx_t_state_ts       (tenant_id, state_code, created_at),
    INDEX idx_t_call_uuid      (tenant_id, call_uuid)
)
PARTITION BY RANGE COLUMNS(created_at) (
    PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
    PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
    -- ... rolled forward by C03's monthly partition-maintainer cron
    PARTITION pmax     VALUES LESS THAN MAXVALUE
);
```

- **Immutability:** C03 owns the GRANT setup — `vici2_app_rw` gets `INSERT, SELECT` only; no `UPDATE`/`DELETE`. Drops only via `vici2_partition_admin` for retention rotation.
- **Retention:** 4 years per SPEC §4.1's audit-on-every-decision requirement; archival to S3 with object-lock per C03 PLAN.
- **Volume estimate:** ~500 rows/day per 100-agent center after sampling (RESEARCH §8.3); ~180k/year/center; ~720k over 4y. Comfortable for monthly partitions.

### 8.2 New table: `state_holidays` (admin-UI display only — gate uses in-code calendar)

```sql
CREATE TABLE state_holidays (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    state_code  CHAR(2) NOT NULL,
    holiday_date DATE NOT NULL,
    name        VARCHAR(64) NOT NULL,
    citation    VARCHAR(128) NULL,
    UNIQUE KEY uk_state_date (state_code, holiday_date)
);
```

Seeded by `tcpa-rulesgen` (§3.4 step 5) with 5 years of expanded dates including computed Mardi Gras / Good Friday for LA. Admin UI (M03) reads this for display; the gate runtime uses `HolidayCalendar` in-process.

### 8.3 New column on `campaigns`

```sql
ALTER TABLE campaigns
  ADD COLUMN unknown_tz_policy ENUM('deny','warn_pass') NOT NULL DEFAULT 'deny';
```

(F02 PLAN's `campaigns` table already exists; this is one column.)

### 8.4 New column on `leads` (only if not already added)

F02 PLAN §4.13 already includes `known_timezone VARCHAR(40) NULL` and `state CHAR(2) NULL` and `postal_code VARCHAR(16) NULL`. **No additions needed.** A `tz_blocked BOOLEAN NOT NULL DEFAULT false` is requested for the M03 admin-review flow when `Check` returns `BLOCK_INVALID(no_timezone)`:

```sql
ALTER TABLE leads
  ADD COLUMN tz_blocked TINYINT(1) NOT NULL DEFAULT 0;
```

### 8.5 Coordination note for orchestrator

These four additions arrive as one F02 IMPLEMENT amendment after F02's primary migration lands. The C01 IMPLEMENT phase blocks on this F02 amendment (cannot write audit rows without the table). Suggested batch order at orchestrator:

```
F02 IMPLEMENT (primary)         ← in flight
  └── F02 IMPLEMENT amendment   ← consolidates C01's call_window_audit + state_holidays + campaigns.unknown_tz_policy + leads.tz_blocked, plus any other module's amendments arriving in this wave
       └── C01 IMPLEMENT can start
       └── C03 IMPLEMENT can start (consumes call_window_audit, state_holidays)
```

---

## 9. Code structure & file layout

```
dialer/internal/compliance/tcpa/
  types.go               # CheckRequest, CheckResult, Window, StateRule, Outcome, EnforcementPoint
  rules.go               # hand-written federal floor consts + helpers + intersect()
  rules_gen.go           # CODE GENERATED — `var stateRules map[string]StateRule`
  holidays.go            # HolidayCalendar struct + IsHoliday + nextBusinessDayOpen helpers
  holidays_gen.go        # CODE GENERATED — 5-year expanded fixed + computed dates
  check.go               # Checker, New, Check, WindowClosesWithin
  audit.go               # Sink interface, StreamSink, StdoutSink
  metrics.go             # Prometheus collectors per §7
  next_open.go           # nextDayOpen / nextDowOpen / nextBusinessDayOpen — DST aware
  reasons.go             # const string for reason vocabulary; assert exhaustive in test
  fixtures_test.go       # the 28-fixture catalog (RESEARCH §10) embedded as JSON
  check_test.go          # table-driven against fixtures; >=95% line coverage gate
  dst_regression_test.go # 5y-forward DST transition fixture
  reasons_test.go        # asserts vocabulary set is exhaustive
  benchmark_test.go      # p99<1ms benchmark
  doc.go                 # package docstring + cross-link to RESEARCH.md/PLAN.md

api/src/compliance/tcpa/
  types.ts
  rules.gen.ts           # CODE GENERATED
  holidays.gen.ts        # CODE GENERATED
  check.ts
  audit.ts               # ioredis XADD wrapper
  metrics.ts             # prom-client
  __tests__/
    check.spec.ts
    fixtures.json        # SHARED with Go (same file path symlinked, or build-time copied)
    dst.spec.ts

scripts/build-tcpa-rules/
  main.go                # generator (§3.4)

db/seeds/
  state_rules.csv        # source-of-truth (§3.3)
  state_holidays.sql     # CODE GENERATED via the same tool

shared/openapi/openapi.yaml
  # Add: schemas for OutsideCallWindow error response (manual dial 412 case)
```

**Cross-language test fixture parity:** the 28 fixtures live in one JSON file under `dialer/internal/compliance/tcpa/fixtures.json` and are consumed by both Go (`embed.FS`) and TS (build-step copy into `api/src/compliance/tcpa/__tests__/fixtures.json`). A CI check fails if the two files diverge.

---

## 10. Test plan

### 10.1 Required acceptance fixtures (28; from RESEARCH §10)

Embedded verbatim. The catalog covers:
- Indiana NXX split (Hammond CT vs Indianapolis ET)
- KY 10am start, TX Sun-noon, FL/WA/WY 8pm cutoff, RI Sat 10–17, ME autodialer 9–17
- HI / AK DST / PR / USVI / Saipan / American Samoa
- Sunday-blackout AL / LA, LA Mardi Gras
- DST spring-forward and fall-back transitions
- Boundary cases (08:00:00 exact, 20:59:30 advisory)
- Unknown NPA → `no_timezone` BLOCK + `warn_pass` policy ALLOW
- Lead `known_timezone` override beats NPA
- ZIP override beats NPA (ported NY area-code → CA zip)

### 10.2 Coverage targets

- `check.go`: ≥95% line (per `C01.md` acceptance criteria).
- `rules.go` + `next_open.go`: ≥90% line.
- `audit.go` (StreamSink): ≥70% (XADD path); StdoutSink at 100%.

### 10.3 Property tests (Phase 1, optional but recommended)

- For random `(state, dow, partyLocal)`, `Check` is monotonic in `partyMins`: once `Outcome` flips from ALLOW to SKIP_UNTIL on the close side, it never flips back until the next-day open.
- `intersect(a, b) == intersect(b, a)`.
- `intersect(a, intersect(b, c)) == intersect(intersect(a, b), c)`.

### 10.4 Performance

`go test -bench=BenchmarkCheck -benchtime=10s` must show **mean <100µs, p99 <1ms** with D03's preloaded cache. Budget breakdown: D03 resolve ≤500µs (its own SLO), C01 work ≤500µs.

### 10.5 DST regression suite

`dst_regression_test.go` iterates US DST transitions for the next 5 years (10 transitions × 4 representative tz: ET/CT/MT/PT). For each transition, four fixtures: 1 minute before, at-the-transition, 1 minute after, 1 hour after. All must produce defined, non-error results.

---

## 11. Operational playbook

### 11.1 Alert: `vici2_compliance_tcpa_outside_window_total > 0` (SEV1)

**Symptom:** any non-ALLOW result at originate point.
**Means:** the hopper gate let through a lead that the originate gate caught — meaning either (a) the lead crossed the boundary while sitting in hopper (acceptable — defense-in-depth working as designed; check rate < 0.1/min) OR (b) the hopper gate is broken (rate >> 0).

**Runbook:**
1. Check `vici2_compliance_tcpa_check_total{enforcement_point="hopper_filler",outcome="ALLOW"}` rate vs originate `outcome="SKIP_UNTIL"` rate. If hopper-allow rate is normal and originate-skip is small, this is normal stale-hopper behavior — log and move on.
2. If originate-skip rate spikes (>1/sec for 5min), suspect E01 not calling `Check`. Query `call_window_audit WHERE enforcement_point='hopper_filler' AND created_at > NOW() - INTERVAL 10 MINUTE` — if count is zero, the gate isn't running in E01.
3. **If `Check` returned ALLOW at originate but a leg actually rang past close:** SEV0. The bug is downstream (T01 didn't honor the SKIP). Page T01 owner.

### 11.2 Alert: `vici2_compliance_tcpa_holiday_calendar_age_seconds > 129600` (36h)

`HolidayCalendar` reload cron is stuck. Manual trigger: `kill -SIGHUP <dialer pid>` (registered in `dialer/cmd/dialer/main.go` to call `holidays.Refresh()`).

### 11.3 New state law passes

Process:
1. Edit `db/seeds/state_rules.csv`.
2. Run `go generate ./dialer/internal/compliance/tcpa/...` and `pnpm -F api gen:tcpa-rules`.
3. Add a fixture covering the new rule.
4. PR; CI gates verify codegen + fixture pass.
5. Deploy. No DB migration needed unless `state_holidays` rows changed (then `go run scripts/build-tcpa-rules` regenerates `db/seeds/state_holidays.sql` and the F02 deploy job replays it).

---

## 12. Hand-off contracts (concrete, per-module)

### 12.1 To **E01** (hopper filler)

- Import: `import "github.com/F01-org/vici2/dialer/internal/compliance/tcpa"`
- Call: `tcpa.Default.Check(ctx, req)` with `EnforcementPoint=PointHopper`. Place this gate **last in the per-lead pipeline** (after DNC scrub) so the cheaper gates fail-fast first (RESEARCH-aligned with E01 §4.1 ordering).
- On `SKIP_UNTIL`: `ZADD t:{tid}:hopper:delayed:{cid} <nextOpenUnix> <leadID>`. The filler tick re-checks via `ZRANGEBYSCORE 0 NOW` and re-runs `Check`.
- On `BLOCK_INVALID(no_timezone)`: `UPDATE leads SET tz_blocked=1 WHERE id=?`. Surfaces in M03 admin UI.
- Skip-reason metric: `vici2_dialer_filler_skipped_total{reason="tcpa_window"}` for SKIP_UNTIL, `tcpa_unknown_tz` for BLOCK.

### 12.2 To **E02** (pacing)

- Import: same package.
- Call: `tcpa.Default.WindowClosesWithin(ctx, req, 5*time.Minute)` for picker deprioritization; `WindowClosesWithin(ctx, req, 30*time.Second)` as a hard "do not initiate" check.
- The `WindowClosesWithin` helper does NOT write audit rows or emit `outside_window_total`; it's advisory-only with its own `boundary_advisory_total` counter.

### 12.3 To **T04** (originate primitive)

- Import: same package.
- Call: `tcpa.Default.Check(ctx, req)` with `EnforcementPoint=PointOriginate` immediately before the `T01.Client.Originate` call. Per T01 PLAN §16.2, T04 owns the gate; T01 owns transport.
- On non-ALLOW: increment `vici2_compliance_tcpa_outside_window_total{enforcement_point="originate_path", reason}`, write a row to T04's existing `originate_audit` table marking why the originate was suppressed, return typed error to caller.
- T04 must NOT proceed to `T01.Client.Originate` on any non-ALLOW outcome.

### 12.4 To **C03** (audit immutability)

- C03 owns the `call_window_audit` table after F02 creates it: GRANT setup, partition rotation, S3 archival, retention enforcement.
- C03 also implements the api worker (`api/workers/audit-flush.ts`) consuming `t:{tid}:audit:tcpa:stream` and INSERTing into the table.
- Same worker handles the `originate_audit` stream from T04. (Single audit-flush worker, multiple input streams.)

### 12.5 To **F02** (schema)

- The four amendments in §8 are filed as one combined IMPLEMENT amendment. Orchestrator coordinates batching with any other module's amendments to keep migration count low.

### 12.6 To **A04 / A07** (manual dial UX)

- TS-side `tcpa.check(req)` returns `CheckResult`. UI surfaces `result.reason + result.nextOpen` on non-ALLOW.
- Legacy adapter `assertCallWindowOrThrow` available for callers preferring throw semantics.
- No "force-dial" / "override" UI option exists. Any UI that shows one is a SEV1 product bug (RESEARCH §9.7 + §11.7).

### 12.7 To **M03** (admin UI)

- New admin view "TZ-Blocked Leads" filters `leads WHERE tz_blocked = 1`. Action button: "Unblock + retry resolution" → API call updates `lead.known_timezone` (or zip) then sets `tz_blocked=0`.
- Admin view "State Holidays" reads `state_holidays` table. Read-only in Phase 1 (rules-as-code; edits via PR).

### 12.8 To **O01** (observability)

- O01 PLAN §3.1 already files a Prometheus alert for the compliance hard floors. C01 IMPLEMENT confirms the metric name `vici2_compliance_tcpa_outside_window_total` exists and is registered.

---

## 13. Open issues / future work (not blocking PLAN)

1. **Frequency caps (FL/OK/MD = 3 calls / 24h same subject)** — out of scope for C01 itself; flagged for a future C05 module per RESEARCH §3 footnote. Track per-lead daily call counts in Redis `t:{tid}:freq:{phone}:{campaign}` with `INCR` + `EXPIRE 86400`.
2. **EIA Petition outcome** — if FCC clarifies that consent moots quiet-hours, add a Phase-4 `lead.has_quiet_hours_consent BOOLEAN` plus `Check` opt-in path. For Phase 1, gate runs unconditionally regardless of consent.
3. **B2B exemption** — Phase 4 only; requires legal review; per-state matrix (WA has none).
4. **EBR exemption** — explicitly NOT honored by the time-window gate (RESEARCH §9.6); the FCC's EBR carve-out is for DNC, not for hours.
5. **California ADAD narrower window** (9pm cutoff for autodialer-with-recorded-message is *not* narrower than fed except in the live-vs-prerecorded distinction). Documented in CSV; if business adds CA ADAD product, add `CA_adad` rule then.
6. **Number-portability detection** — Phase 4 hardening hook into a carrier-lookup service (Neustar, RealPhoneValidation) to flag mobile numbers with high-confidence current-location vs original-NPA. Out of scope.
7. **SMS gate** — Bernal et al. wave subjects SMS to the same window. When/if vici2 ships SMS, route through `tcpa.Check(EnforcementPoint=PointSMS)` (vocab addition).
8. **Voicemail-drop after answer** — if call connected before close and went to VM, dropping a message at 21:01 is generally OK; codify as: if `now() > effective.CloseLocal` at drop-trigger time, suppress the drop.

---

## 14. Risks (carried forward + new)

| Risk | Owner | Mitigation |
|---|---|---|
| Rule matrix drifts between Go and TS | C01 | Single CSV source-of-truth + CI codegen check |
| State law changes mid-quarter and we miss it | Ops | Quarterly compliance review; `state_rules.csv` PR is the change log |
| 2025 quiet-hours litigation wave (100+ class actions for time-of-day even with consent) | Legal | Conservative posture: gate runs regardless of consent, regardless of EBR/B2B (Phase 1) |
| EIA Petition resolves narrower than expected | Legal | If consent moots quiet-hours, Phase 4 opt-in path; gate stays default-on |
| `leads.tz_blocked` flag leaves leads stuck forever | M03 | Surface the queue in admin UI from day 1; nightly metric on count |
| Audit write path (Stream → MySQL) backs up | C03 | `audit_dropped_total` alert at >100/h; MAXLEN 100k stream cap; back-pressure visible |
| DST off-by-one regression | C01 | `dst_regression_test.go` runs nightly in CI on next 5 years of transitions |
| Stale `Date.now()` in long-running hopper sits | Already mitigated | T04 re-checks at originate (defense in depth) — RESEARCH §7.4 |
| Plaintiff subpoenas the manual-dial override | C01 | No override exists. Codified, tested, documented (§5.4, §13). |

---

## 15. Acceptance criteria (lifted + sharpened from `C01.md`)

- [ ] Single `Check` function used by all dial paths (Go: E01, E02, T04; TS: A04 manual dial). Verified by import-graph linter.
- [ ] Most-restrictive rule wins (federal ∩ state ∩ campaign[, ∩ ME-auto]). Verified by RI-Sat fixture.
- [ ] Configurable `unknown_tz_policy` per campaign (default: deny). Verified by fixtures #23 + #24.
- [ ] Audit row on every `BLOCK_INVALID` and `SKIP_UNTIL`; sampled `ALLOW`. Verified by integration test against StreamSink.
- [ ] `vici2_compliance_tcpa_check_total` and `vici2_compliance_tcpa_outside_window_total` metrics exported. Verified by metrics endpoint scrape test.
- [ ] DST transitions handled: 28 fixtures + 5y-forward regression suite all green.
- [ ] Indiana NXX split correctly resolved (via D03): Hammond → America/Chicago, Indianapolis → America/Indianapolis. Verified by fixtures #5 + #6.
- [ ] No "manual override" code path. Verified by source grep + acceptance test that `EnforcementPoint=PointManual` gives identical outcome to `PointOriginate` for the same `req`.
- [ ] Pure-function under fixed `nowFn`: same input → same output. Verified by property test.
- [ ] Performance: p99 < 1ms benchmark gate.
- [ ] Code coverage ≥95% on `check.go`.

---

## 16. STOP

PLAN complete. F02 amendment requested per §8. No code in this PLAN. Proceed to checkpoint review; on approval, IMPLEMENT phase begins after F02 amendment lands.
