# C02 — Recording Consent State Matrix — PLAN

| Field | Value |
|---|---|
| Track | Compliance (cross-cutting) |
| Phase | 1 |
| Effort | 2 days |
| Owner agent type | backend-go (canonical) + backend-node (mirror, deferred to Phase 1.5) |
| Status | PLAN |
| Depends-on (DONE/PLAN-stable) | D03 (state resolver), F02 (`leads.state`, `leads.is_business`, `tenants`, `campaigns`), R01 (consent_status channel-var contract), T04 (5th of 5 pre-originate gates) |
| Blocks | T04 (originate gate), R01 (record_session conditional), F03 (consent extensions), F02-amendments (consent_log + 4 columns), M02 (campaign editor), M05 (tenant editor), O01 (alert rules) |

> **Stakes restated.** Vici2 markets to outbound call centers; outbound call centers get sued for missing recording consent in two-party-consent states. Cal. Penal Code §637.2 sets statutory damages at **$5,000/call**, commonly class-aggregated across an entire campaign — a 50,000-call campaign = $250M exposure in CA alone (RESEARCH §13). Q1 2025 saw **507 new TCPA class actions, +112% YoY**, with **31–41% from serial plaintiffs** who pile on CIPA/IL-Eavesdropping claims alongside TCPA (RESEARCH §1.9, §13). SPEC §4.1 names the consent prompt an unwaivable hard floor: "Recording consent prompt (in 2-party-consent states) before agent bridge." **R01 cannot start `record_session` unless C02 has already decided it is allowed.**

---

## 0. TL;DR — 10-bullet decision summary

1. **C02 is a state-matrix lookup + decision module.** Output: a typed `CheckResult{Decision, StateApplied, Mechanism, Reason}` consumed by T04 (originate gate, channel-var writer) and R01 (dialplan record_session gate). C02 does NOT play audio (F03 does), does NOT write recording files (R01 does), does NOT enforce immutability of the audit log (C03 does). C02 is the **decider**.
2. **Five exhaustive decision modes**, ordered by strictness: `ALLOW < PROMPT_BEEP < PROMPT_MESSAGE < REQUIRE_ACTIVE < SKIP` (RESEARCH §4). Every `CheckConsent` call returns exactly one. Stricter-state-wins via `stricter_of(...)` four-way intersection: legal-floor-for-lead, legal-floor-for-caller, tenant minimum, campaign override.
3. **13 two-party-consent states are coded** (RESEARCH §3 — list includes OR for industry-conservative posture; CT counted for civil safety): **CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA**. All other 50 US states + DC + 5 territories default to `ALLOW` (1-party federal floor under 18 USC §2511(2)(d)). The SPEC's "12 two-party states" is the strict-2-party count; we ship the conservative 13 per RESEARCH §1.2.
4. **Default mode in 2-party states is `PROMPT_MESSAGE`** (verbal disclosure + implied consent via continued participation) — the established judicial gloss in CA, IL, MA, PA, WA (RESEARCH §1.5, §8.4). **Beep is opt-in only** (`PROMPT_BEEP`); §64.501 binds carriers, not enterprises, and state courts disfavor tone-only notice (RESEARCH §8). `REQUIRE_ACTIVE` (DTMF press-1) is tenant-elective for high-risk verticals (collections, healthcare).
5. **Stricter-state-wins for interstate calls** (Kearney v. Salomon Smith Barney, 39 Cal.4th 95 (2006); RESEARCH §7). If either end of the call is in a 2-party state, the 2-party rule applies. C02 takes the max-of-strictness across lead-state-rule and caller-state-rule before applying tenant/campaign overrides.
6. **Per-call durability, never per-lead** (RESEARCH §12). Statutes treat each communication as its own event; consent on call N does NOT extend to call N+1. C02 writes one `consent_log` row per call, keyed on `call_uuid`. Lead-level "this person consented" flags are explicitly out of scope (dangerous false-security).
7. **B2B carve-out is PA-only in Phase 1** (RESEARCH §1.7, §6). 18 Pa.C.S. §5704(15) permits one-party recording of telephone-marketing/QC training calls **iff destroyed within 1 year**. CA's analogous narrow exemption is post-Taylor v. ConverseNow (N.D. Cal. 2025) effectively closed for any call where PII flows — Phase 4 only. The `LeadIsBusiness` flag + `campaigns.recording_purpose ∈ {training, quality_control, monitoring}` are both required to trigger the PA carve-out.
8. **Unknown lead-state defaults to `PROMPT_MESSAGE`** (conservative; same posture as 2-party states) AND pages O01 via `vici2_compliance_consent_state_missing_total` (RESEARCH §5.3). Unknown caller-state defaults to `ALLOW` for the interstate intersection (least-permissive lead-state rule still wins) and pages O01 via `vici2_compliance_consent_caller_state_missing_total`.
9. **Matrix-in-code pattern follows C01 exactly** (RESEARCH §1.13). Single source-of-truth `db/seeds/consent_rules.csv` → codegen produces `dialer/internal/compliance/consent/rules_gen.go` (Phase 1) and `api/src/compliance/consent/rules.gen.ts` (Phase 1.5). Manual edits to `*_gen.*` forbidden; PR + deploy is the change-control process. Same generator pattern as `tcpa-rulesgen` (C01 §3).
10. **F02-amendments will land 1 new table + 6 new columns** (§9). `consent_log` (INSERT-only, monthly partitioned, 7-year retention); `tenants.consent_minimum_mode` + `tenants.default_caller_state`; `campaigns.consent_policy_override` + `recording_purpose` + `opt_out_action` + `consent_msg_audio`. Coordinated with C01's `call_window_audit` amendment in the same F02-amendment batch.

---

## 1. Goals + non-goals

### 1.1 In scope (this PLAN's deliverable)
- The `CheckConsent(ctx, req) → CheckResult` Go function in `dialer/internal/compliance/consent/`.
- The federal + state consent-rule matrix encoded as Go data, generated from `db/seeds/consent_rules.csv`.
- The five decision modes vocabulary (`ALLOW`, `PROMPT_BEEP`, `PROMPT_MESSAGE`, `REQUIRE_ACTIVE`, `SKIP`) with strictness ordering for `stricter_of()`.
- The PA B2B carve-out (LeadIsBusiness + recording_purpose check).
- The audit-emit hook into the C03-owned async writer (writes via the same Valkey-Stream pattern as C01).
- The metrics surface (`vici2_compliance_consent_*`).
- F02 amendment request: `consent_log` table + 6 columns on `tenants` and `campaigns` (§9).
- The 15-fixture acceptance test catalog (§11.1).
- Phase 1 Go-only (canonical); TS mirror deferred to Phase 1.5 (A04 manual dial UX surfaces the decision but does not need to re-decide — T04 is the deciding seam).

### 1.2 Out of scope (handed off)
- **Audio playback** (`playback ${consent_msg_audio}`, `play_and_get_digits` for active consent) → **F03** dialplan extensions `consent_message_only`, `consent_message_active`, `consent_beep_continuous`, `recording_consent_check` (RESEARCH §10.2).
- **`record_session` invocation** → **R01**. R01 reads `vici2_consent_status` channel-var; C02 sets it via T04.
- **Audit table immutability + grants + retention** → **C03** (consumes `consent_log`).
- **Audit table schema** → **F02-amendments** (request filed by C02 in §9).
- **State resolution from phone/ZIP/area code** → **D03**. C02 receives `lead.state` and `caller.state` as inputs.
- **TCPA quiet-hours gate** → **C01** (orthogonal; runs in same T04 pipeline but separate decision).
- **DNC scrub** → **D05** (runs before C02 in T04's 5-gate order).
- **PCI DTMF suppression during recording** → **R01 Phase 2 sidecar** (PCI Pal / Eckoh layer on top of C02's decision; C02 stays out of PCI scope, RESEARCH §1.12).
- **Audio file management UX** → **M02** campaign editor surfaces `consent_msg_audio` field; C02 provides the contract.

### 1.3 What changed vs. RESEARCH

| RESEARCH open question (§16) | PLAN decision |
|---|---|
| Q1: Default mode in 2-party states | `PROMPT_MESSAGE`. Codified as `consent_rules.csv` default per row. |
| Q2: Default mode in 1-party states | `ALLOW`. Absence-from-CSV = `ALLOW`. |
| Q3: Unknown lead-state | `PROMPT_MESSAGE` (conservative) + page O01. |
| Q4: Beep-only default? | NO. Opt-in via `tenants.consent_minimum_mode=PROMPT_BEEP` or `campaigns.consent_policy_override=PROMPT_BEEP`. |
| Q5: B2B carve-out scope | PA only Phase 1. CA Phase 4. Other states: never. |
| Q6: Per-call vs per-lead durability | Per-call. `consent_log` keyed on `call_uuid`. Lead-level flags forbidden. |
| Q7: Caller-state source | `tenants.default_caller_state` Phase 1; `users.state` Phase 4 (remote agents). |
| Q8: Decline behavior | Per-campaign: `opt_out_action ∈ {continue_no_record, hangup}`. |
| Q9: Audio file path | Per-campaign `consent_msg_audio` column; default `freeswitch/sounds/consent/vici2_consent_msg_default.wav`. |
| Q10: Codegen pattern | Single CSV → Go + TS; mirror C01's `tcpa-rulesgen`. |
| Q11: Test fixtures | 15 fixtures spanning all 13 strict states + edge cases (§11.1). |
| Q12: CT civil-vs-criminal | Treat CT as 2-party (civil-side safety). |
| Q13: OR electronic-vs-in-person | Treat OR as 2-party for telephone (industry posture). |

---

## 2. Public interface (Go canonical)

### 2.1 Types — `dialer/internal/compliance/consent/types.go`

```go
package consent

// Mode is the decision vocabulary, ordered low-to-high strictness.
type Mode uint8
const (
    ModeAllow         Mode = iota  // 0  — 1-party state; no prompt; record immediately
    ModePromptBeep                 // 1  — §64.501 continuous beep; record immediately
    ModePromptMessage              // 2  — verbal disclosure; implied consent via continued participation
    ModeRequireActive              // 3  — verbal + DTMF/ASR confirmation
    ModeSkip                       // 4  — do NOT record
)

func (m Mode) String() string  // "ALLOW" | "PROMPT_BEEP" | "PROMPT_MESSAGE" | "REQUIRE_ACTIVE" | "SKIP"

// Strictness ordering — used by stricter_of(...) intersection.
// SKIP > REQUIRE_ACTIVE > PROMPT_MESSAGE > PROMPT_BEEP > ALLOW
func StricterOf(a, b Mode) Mode {
    if a > b { return a }
    return b
}

type RecordingPurpose string
const (
    PurposeGeneral        RecordingPurpose = "general"
    PurposeTraining       RecordingPurpose = "training"
    PurposeQualityControl RecordingPurpose = "quality_control"
    PurposeMonitoring     RecordingPurpose = "monitoring"
)

type CampaignRecordingPolicy string
const (
    PolicyAlways    CampaignRecordingPolicy = "ALWAYS"
    PolicyNever     CampaignRecordingPolicy = "NEVER"
    PolicyOnDemand  CampaignRecordingPolicy = "ON_DEMAND"
    PolicyAuto      CampaignRecordingPolicy = "AUTO"
)

type CheckRequest struct {
    TenantID    int64
    CampaignID  int64
    LeadID      int64
    CallUUID    string  // for audit row; empty at hopper-time, set at originate

    // State signals — populated by T04 from D03 + tenant config
    LeadState     string  // 2-letter US code; "" if unknown
    CallerState   string  // 2-letter US code; "" if unknown (Phase 4: per-user)

    // B2B + purpose
    LeadIsBusiness          bool             // from leads.is_business
    CampaignRecordingPurpose RecordingPurpose // from campaigns.recording_purpose

    // Campaign / tenant policy
    CampaignRecordingPolicy CampaignRecordingPolicy
    TenantMinimumMode       Mode
    CampaignOverrideMode    *Mode  // nil = use tenant minimum

    // Audio asset (passes through to channel vars; C02 doesn't validate it exists)
    ConsentMsgAudioPath string  // e.g., "/var/lib/freeswitch/sounds/consent/tenant_42/msg.wav"
    OptOutAction        string  // "continue_no_record" | "hangup"

    // Time anchor for audit; defaults to time.Now() at caller
    When time.Time
}

type CheckResult struct {
    Decision     Mode
    StateApplied string  // 2-letter code that drove the decision (after stricter-state-wins)
    Mechanism    string  // "PROMPT_MESSAGE/lead-state-CA" — human-readable
    Reason       string  // controlled vocab; see §2.3
    PromptAudio  string  // mirrored from req if Decision needs a prompt; "" if ModeAllow
    OptOutAction string  // mirrored from req if Decision == ModeRequireActive
    // For T04 channel-var serialization:
    ConsentRequired bool   // true iff Decision != ModeAllow && Decision != ModeSkip
    ConsentRecord   bool   // true iff Decision ∈ {Allow, PromptBeep, PromptMessage} OR (RequireActive AND assumed-yes)
    Citation        string // statute cite for audit log
}
```

### 2.2 Functions — `dialer/internal/compliance/consent/check.go`

```go
type Checker struct {
    rules     map[string]ConsentRule  // codegen; keyed by 2-letter state
    audit     audit.Sink              // §8 — async writer to consent_log
    metrics   *metrics                // wraps prometheus collectors
    nowFn     func() time.Time        // overridable for tests
}

type CheckerOpts struct {
    Audit  audit.Sink
    NowFn  func() time.Time   // nil → time.Now
}

func New(opts CheckerOpts) (*Checker, error)

// CheckConsent is the canonical decision function. Pure modulo nowFn + side-effects.
// Hot-path SLO: p99 < 200µs (T04 RESEARCH §3.5 budget).
func (c *Checker) CheckConsent(ctx context.Context, req CheckRequest) (CheckResult, error)

// Default singleton populated by New(); package-level helper for callers
// that don't want to thread the Checker explicitly.
var Default *Checker
```

The package also exposes the data type for the codegen target:

```go
type ConsentRule struct {
    State        string   // 2-letter
    MinimumMode  Mode     // PROMPT_MESSAGE for 2-party; ALLOW absent from map
    BeepAccepted bool     // for tenant policy validation; not currently used by Check
    B2BExempt    bool     // true only for PA Phase 1
    Citation     string   // for audit log; e.g., "Cal. Penal Code §§632 632.7"
}
```

### 2.3 `Reason` controlled vocabulary

The `Reason` string is a stable enum — audit queries and metric labels stay low-cardinality:

```
ok                          # ModeAllow with no overrides; pure 1-party
campaign_disabled           # campaigns.recording_policy=NEVER → ModeSkip
tenant_policy_skip          # tenants.consent_minimum_mode=SKIP
state_2party_lead           # lead-state 2-party drove ModePromptMessage
state_2party_caller         # caller-state 2-party drove ModePromptMessage (Kearney)
state_2party_both           # both states 2-party — pick the stricter
tenant_minimum_floor        # tenant.consent_minimum_mode bumped legal floor up
campaign_override           # campaigns.consent_policy_override bumped above tenant
b2b_pa_carveout             # PA §5704(15) downgraded PROMPT_MESSAGE → ALLOW
lead_state_unknown          # lead.state=NULL; defaulted to PROMPT_MESSAGE + page
caller_state_unknown        # tenant.default_caller_state=NULL; treated as ALLOW; page
require_active_tenant       # ModeRequireActive via tenant policy
require_active_campaign     # ModeRequireActive via campaign override
beep_tenant                 # ModePromptBeep via tenant policy (§64.501-bound tenants)
beep_campaign               # ModePromptBeep via campaign override
```

A unit test asserts the set is exhaustive — no string outside this set is ever returned. Adding a new reason requires PR + linter update.

### 2.4 No gRPC Phase 1

Per C01 §2.3 pattern: both Go (T04, R01) consume `CheckConsent` directly. Node-side A04 manual dial path does NOT independently re-decide; it surfaces T04's decision via the API response. Phase 1.5 may add a TS mirror for pre-flight UX validation, but T04 remains the authoritative seam.

---

## 3. State matrix — the 13 two-party states + 38 one-party

### 3.1 Encoding decision: matrix-in-code (mirror C01)

**Source of truth:** `db/seeds/consent_rules.csv` — committed to repo.
**Codegen:** `scripts/build-consent-rules/main.go` (new tool) reads CSV → emits `dialer/internal/compliance/consent/rules_gen.go` + (Phase 1.5) `api/src/compliance/consent/rules.gen.ts`. CI gate runs the generator and `git diff --exit-code`s. Manual edits to `*_gen.*` forbidden.

| Option | Verdict |
|---|---|
| MySQL `consent_rules` table | ❌ — jurisdictional rule, not tenant data; cache needed in Go hot path; "edited by `bob` at 2:14am" is a litigation artifact |
| Runtime JSON config | ❌ — drift between Go and TS; needs file-watcher |
| **Matrix in Go code, codegen from CSV** | ✅ — compile-time; `git blame` shows who/when/why; PR is the change-control process; lockstep with TS via codegen |

### 3.2 The 13 strict 2-party rows (from RESEARCH §3)

| State | Statute | Default mode | Beep accepted? | B2B exempt? | Notes (RESEARCH §3 row) |
|---|---|---|---|---|---|
| **CA** | Cal. Penal Code §§632, 632.7 (CIPA) | `PROMPT_MESSAGE` | NO | NO (Phase 1; CA reopen Phase 4 post-*Taylor*) | $5K/call statutory damages (§637.2). §632.7 covers cell/cordless. |
| **CT** | Conn. Gen. Stat. §52-570d | `PROMPT_MESSAGE` | NO | NO | Civil = 2-party (safety posture); criminal = 1-party. §52-570d allows implied consent. |
| **DE** | 11 Del.C. §1335 | `PROMPT_MESSAGE` | NO | NO | Stricter-state-wins among DE's 1-party-criminal + 2-party-civil statutes. |
| **FL** | Fla. Stat. §934.03 | `PROMPT_MESSAGE` | NO | NO | All-party. Felony violation. |
| **IL** | 720 ILCS 5/14-2 (post-2014) | `PROMPT_MESSAGE` | NO | NO | All-party for "private conversation" (intent-to-be-private test). |
| **MD** | Md. Cts. & Jud. Proc. §10-402 | `PROMPT_MESSAGE` | NO | NO | All-party. Felony. |
| **MA** | Mass. Gen. Laws ch. 272 §99 | `PROMPT_MESSAGE` | NO | NO | "Secretly" recording = operative test; clear disclosure cures. |
| **MI** | Mich. Comp. Laws §750.539c | `PROMPT_MESSAGE` | NO | NO | Treated as all-party for conservative posture (Sullivan v. Gray line). |
| **MT** | Mont. Code Ann. §45-8-213 | `PROMPT_MESSAGE` | NO | NO | All-party w/ narrow carve-outs. |
| **NH** | N.H. Rev. Stat. §570-A:2 | `PROMPT_MESSAGE` | NO | NO | Among strictest. |
| **OR** | Or. Rev. Stat. §165.540 | `PROMPT_MESSAGE` | NO | NO | Technically 1-party for telephone; UTPA overlay → industry treats as 2-party. Conservative default. |
| **PA** | 18 Pa.C.S. §§5703–5704 (WESCA) | `PROMPT_MESSAGE` | NO | **YES — §5704(15)** | Felony. B2B carve-out for telephone-marketing/QC training **with 1-year retention cap** (C04 enforces). |
| **WA** | Wash. Rev. Code §9.73.030 | `PROMPT_MESSAGE` | NO | NO | All-party. §9.73.030(3) recognizes announcement-then-continued-call implied consent. |

### 3.3 `db/seeds/consent_rules.csv` shape

```csv
state,minimum_mode,beep_accepted,b2b_exempt,citation,comment
CA,PROMPT_MESSAGE,false,false,Cal. Penal Code §§632 632.7,CIPA; $5K/call §637.2
CT,PROMPT_MESSAGE,false,false,Conn. Gen. Stat. §52-570d,Civil-safety posture
DE,PROMPT_MESSAGE,false,false,11 Del.C. §1335,
FL,PROMPT_MESSAGE,false,false,Fla. Stat. §934.03,Felony violation
IL,PROMPT_MESSAGE,false,false,720 ILCS 5/14-2,Post-2014 intent-to-be-private test
MD,PROMPT_MESSAGE,false,false,Md. Cts. & Jud. Proc. §10-402,Felony
MA,PROMPT_MESSAGE,false,false,Mass. Gen. Laws ch.272 §99,"Secretly" test
MI,PROMPT_MESSAGE,false,false,Mich. Comp. Laws §750.539c,Sullivan v. Gray conservative read
MT,PROMPT_MESSAGE,false,false,Mont. Code Ann. §45-8-213,
NH,PROMPT_MESSAGE,false,false,N.H. Rev. Stat. §570-A:2,Strictest tier
OR,PROMPT_MESSAGE,false,false,Or. Rev. Stat. §165.540,Phone tech 1-party; UTPA overlay → 2-party posture
PA,PROMPT_MESSAGE,false,true,18 Pa.C.S. §§5703-5704,B2B carveout §5704(15); 1-yr retention
WA,PROMPT_MESSAGE,false,false,Wash. Rev. Code §9.73.030,Announcement-then-continued-call doctrine
# All other US states + DC + AS/GU/MP/PR/VI: absence = ALLOW (1-party federal floor)
```

### 3.4 Generator pseudocode (`scripts/build-consent-rules/main.go`)

```
input:  db/seeds/consent_rules.csv
output: dialer/internal/compliance/consent/rules_gen.go
        api/src/compliance/consent/rules.gen.ts  (Phase 1.5)

steps:
  1. parse CSV; validate every state code is 2-letter US-postal valid
  2. validate minimum_mode ∈ {ALLOW, PROMPT_BEEP, PROMPT_MESSAGE, REQUIRE_ACTIVE, SKIP}
  3. validate b2b_exempt=true only for PA (Phase 1 lock; remove guard when CA Phase 4 lands)
  4. emit Go: gofmt'd `var stateRules = map[string]ConsentRule{...}` literal
  5. emit TS (Phase 1.5): prettier'd frozen object literal
  6. write header `// Code generated by consent-rulesgen; DO NOT EDIT.`
```

Run via `go generate ./dialer/internal/compliance/consent/...`. CI step in `.github/workflows/ci.yml` after the existing `tcpa-rulesgen` check.

---

## 4. Determination algorithm

### 4.1 `Decide(callerState, leadState, recordingMode, …) → Decision`

The algorithm formalizes RESEARCH §5.3 + §9.3:

```
func (c *Checker) CheckConsent(ctx, req CheckRequest) (CheckResult, error):

    # ─── Step 0: input normalization ───
    if req.When.IsZero(): req.When = c.nowFn()

    # ─── Step 1: short-circuit on campaign-disabled ───
    if req.CampaignRecordingPolicy == PolicyNever:
        return c.emit(req, CheckResult{
            Decision: ModeSkip,
            Reason: "campaign_disabled",
            Mechanism: "campaign-recording-never",
            ConsentRequired: false,
            ConsentRecord: false,
        }), nil

    # ─── Step 2: resolve legal floor per state ───
    legalLead, leadHas    = c.rules[req.LeadState]
    legalCaller, callerHas = c.rules[req.CallerState]

    leadMode   := ModeAllow
    leadCite   := ""
    if leadHas:
        leadMode  = legalLead.MinimumMode
        leadCite  = legalLead.Citation
    else if req.LeadState == "":
        leadMode = ModePromptMessage         # unknown → conservative
        c.metrics.StateMissing.WithLabelValues("lead").Inc()
        # NOTE: emit reason "lead_state_unknown" at result-construction time

    callerMode := ModeAllow
    if callerHas:
        callerMode = legalCaller.MinimumMode
    else if req.CallerState == "":
        # caller-state unknown → treat as 1-party (least permissive lead-side still wins)
        c.metrics.StateMissing.WithLabelValues("caller").Inc()

    # ─── Step 3: stricter-state-wins (Kearney) ───
    legalFloor := StricterOf(leadMode, callerMode)
    drivingState := req.LeadState
    if callerMode > leadMode: drivingState = req.CallerState
    if leadMode == callerMode && leadHas: drivingState = req.LeadState

    # ─── Step 4: B2B carve-out (PA Phase 1 only) ───
    b2bApplied := false
    if req.LeadIsBusiness && leadHas && legalLead.B2BExempt:
        if req.CampaignRecordingPurpose ∈ {Training, QualityControl, Monitoring}:
            legalFloor = ModeAllow
            b2bApplied = true
            # Note: 1-yr retention requirement enforced by C04, not here

    # ─── Step 5: layer tenant minimum ───
    legalOrTenant := StricterOf(legalFloor, req.TenantMinimumMode)
    tenantBumped  := req.TenantMinimumMode > legalFloor

    # ─── Step 6: layer campaign override (subject to legal floor) ───
    final := legalOrTenant
    campaignBumped := false
    if req.CampaignOverrideMode != nil:
        # Campaign can only TIGHTEN, never loosen below legal floor
        # (The Mode ordering enforces this naturally — campaign override must be >= legalFloor)
        final = StricterOf(legalOrTenant, *req.CampaignOverrideMode)
        if *req.CampaignOverrideMode > legalOrTenant: campaignBumped = true

    # ─── Step 7: build result + reason ───
    reason := pickReason(b2bApplied, campaignBumped, tenantBumped,
                         leadMode, callerMode, leadHas, callerHas,
                         req.LeadState, req.CallerState)

    res := CheckResult{
        Decision:       final,
        StateApplied:   drivingState,
        Mechanism:      fmt.Sprintf("%s/lead=%s/caller=%s", final, req.LeadState, req.CallerState),
        Reason:         reason,
        Citation:       leadCite,
        ConsentRequired: final != ModeAllow && final != ModeSkip,
        ConsentRecord:   final != ModeSkip,
        PromptAudio:     req.ConsentMsgAudioPath if final ∈ {PromptMessage, RequireActive} else "",
        OptOutAction:    req.OptOutAction if final == ModeRequireActive else "",
    }

    return c.emit(req, res), nil
```

### 4.2 Hot-path performance

- Pure data lookup (no DB, no Redis); reads in-memory `stateRules map[string]ConsentRule` (codegen).
- Target: **p99 < 200µs** (T04 RESEARCH §3.5 budget for the 5th gate).
- Zero allocations on hot path: pre-allocated `CheckResult`, string interning for state codes via Go's small-string pool.
- Audit emit is async (Valkey Stream); does not block the hot path.

### 4.3 Edge cases (documented + tested)

| Edge case | C02 behavior | Test fixture |
|---|---|---|
| **Mobile-roaming** (CA-area-code phone in TX) | C02 trusts `req.LeadState` from D03. D03 resolves via `leads.state` (CSV import field) first, then ZIP, then NPA-NXX. If the lead was correctly tagged TX in CRM → `ALLOW`. If only the phone number is available → D03 returns CA → `PROMPT_MESSAGE`. This is the documented limitation; conservative default (`PROMPT_MESSAGE`) is the legally-defensible posture. | #14 |
| **VoIP-without-LRN** (no carrier database hit) | D03 returns `lead.state=""`; C02 defaults to `PROMPT_MESSAGE` + emits `vici2_compliance_consent_state_missing_total`. | #11 |
| **Unknown called-party state entirely** | Same as above: `PROMPT_MESSAGE` + page. The cost of false-PROMPT is ~2s extra per call; the cost of false-ALLOW is $5K/call. | #11 |
| **Caller state unknown** (`tenants.default_caller_state IS NULL`) | Treat as 1-party for the stricter-of intersection (lead-state rule still wins). Page `vici2_compliance_consent_caller_state_missing_total`. | #12 |
| **Both states 2-party, different modes** (e.g., lead=CA tenant minimum=REQUIRE_ACTIVE) | Stricter wins: ModeRequireActive. | #15 |
| **Campaign tries to loosen below legal floor** (campaign override=ALLOW, lead=CA) | Final = max(ALLOW, PROMPT_MESSAGE) = PROMPT_MESSAGE. Campaign cannot drop below floor; the StricterOf monotonic. | #4 |
| **B2B + PA + general purpose** (`recording_purpose=general`) | NOT exempt — PA §5704(15) only covers training/QC/monitoring. Stays at PROMPT_MESSAGE. | #6 |
| **B2B + non-PA 2-party state** (e.g., FL business call) | NOT exempt — only PA gets B2B carveout Phase 1. Stays at PROMPT_MESSAGE. | #7 |
| **Federal 1-party only** (TX→TX) | ALLOW. | #1 |
| **Tenant minimum SKIP** (no recording globally) | SKIP regardless of state law (more restrictive than law allows; tenant's choice). | #9 |

---

## 5. Disclosure mechanics

C02 decides which disclosure mechanism is required; F03's dialplan extensions execute it. The interface is the `vici2_consent_mode` channel-var (set by T04 from `CheckResult.Decision`).

### 5.1 The four executable mechanisms (F03 PLAN consumes)

| `vici2_consent_mode` | F03 extension | Audio | Confirmation | Timing |
|---|---|---|---|---|
| `ALLOW` | `recording_consent_check` → `set consent_record_enabled=true` | none | none | Before bridge; ~0ms added |
| `PROMPT_BEEP` | `consent_beep_continuous` | `tone_stream://%(500,0,1400)` looped during record_session | none | Beep starts before bridge; continues entire call |
| `PROMPT_MESSAGE` | `consent_message_only` | `playback ${consent_msg_audio}` (default ~2s) | implied (continued participation) | Before bridge; ~2–3s added |
| `REQUIRE_ACTIVE` | `consent_message_active` | `play_and_get_digits 1 1 3 5000 # ${consent_msg_audio} ... [12]` | DTMF `1`=accept, `2`=decline | Before bridge; ~3–5s added |

### 5.2 Per-language audio files

`campaigns.consent_msg_audio` is a relative path under `/var/lib/freeswitch/sounds/consent/`. Convention:

```
/var/lib/freeswitch/sounds/consent/
  default/
    en-US/vici2_consent_msg.wav        # "This call may be recorded for quality."
    es-US/vici2_consent_msg.wav        # "Esta llamada puede ser grabada..."
  tenant_42/
    en-US/custom.wav                    # tenant override
```

Phase 1: English-only default; tenants upload their own via M02. M02 PLAN (forward-looking) will store uploaded audio in S3 + sync to FS box via D02's filesystem layer. Per-language switching = Phase 4 (consumed from `lead.preferred_language` once D01 adds the column).

### 5.3 Timing — before vs at start

All four mechanisms run on the **customer leg's `CHANNEL_ANSWER`**, **before** the bridge to the agent's conference. This is RESEARCH §10.2 + R01 PLAN §10.1 + R01 PLAN §11 contract: `record_session` is gated on `${consent_record_enabled}=true`, and that var only gets set after F03 extensions return.

**Why before-bridge:** judicial gloss in CA, IL, MA, PA, WA universally requires the disclosure be **clear, audible, and at the start of the call** — not buried mid-conversation. Post-bridge disclosure (agent says it) is acceptable in 1-party states but does NOT satisfy 2-party requirements (agent may forget; recording starts before disclosure). C02's mechanism is therefore pre-bridge by design.

### 5.4 Confirmation key-press (REQUIRE_ACTIVE only)

`play_and_get_digits` configuration per RESEARCH §10.2:
- Min 1 digit, max 1 digit, max 3 retries, 5000ms timeout, regex `[12]`.
- `1` → `vici2_consent_dtmf=1` → `consent_record_enabled=true`, `vici2_consent_status=prompted_accepted`.
- `2` → `vici2_consent_dtmf=2` → `consent_record_enabled=false`, `vici2_consent_status=prompted_declined`.
- Timeout / invalid → `consent_record_enabled=false`, `vici2_consent_status=prompted_declined`.

On decline (`prompted_declined`):
- `campaigns.opt_out_action='continue_no_record'` → bridge to agent, no recording.
- `campaigns.opt_out_action='hangup'` → hang up the customer leg, do NOT bridge.

---

## 6. Schema dependencies — column-by-column

The schema columns C02 reads (already exist or are filed as F02-amendments in §9):

| Table / Column | Source | C02 read/write | F02 status |
|---|---|---|---|
| `tenants.consent_minimum_mode` | Tenant config (M05) | C02 reads | **F02 amendment** (§9.2) |
| `tenants.default_caller_state` | Tenant config (M05) | C02 reads | **F02 amendment** (§9.2) |
| `campaigns.consent_policy_override` | Campaign config (M02) | C02 reads | **F02 amendment** (§9.3) |
| `campaigns.recording_policy` | Campaign config | C02 reads (for `NEVER` short-circuit) | F02 PLAN existing |
| `campaigns.recording_purpose` | Campaign config (M02) | C02 reads (for PA B2B carveout) | **F02 amendment** (§9.3) |
| `campaigns.opt_out_action` | Campaign config (M02) | C02 reads (passes through to channel var) | **F02 amendment** (§9.3) |
| `campaigns.consent_msg_audio` | Campaign config (M02) | C02 reads (passes through) | **F02 amendment** (§9.3) |
| `leads.state` | D01 (CSV import) → D03 (resolution) | C02 reads via T04 | F02 PLAN existing |
| `leads.is_business` | D01 (CSV import) | C02 reads via T04 | **F02 amendment** (§9.4) — confirm with D01 PLAN |
| `call_log.consent_decision` | C02 writes via T04 | T04 writes inline | F02 PLAN existing (T04 already coordinated) |
| `call_log.consent_state` | C02 writes via T04 | T04 writes inline | F02 PLAN existing |
| `consent_log.*` | C02 writes via audit Sink | C02 writes async | **F02 amendment** (§9.1) — new table |

**Cross-module note:** the `tenants` and `campaigns` columns are part of a single F02 amendment batch coordinated with C01's `call_window_audit` table and other module amendments (§9.5).

---

## 7. Three integration points

### 7.1 T04 (originate) — call-time invocation

Per T04 RESEARCH §3.5, `CheckConsent` is the 5th of 5 pre-originate gates (after concurrent-cap, drop-rate, TCPA window, DNC).

**Sequence in `dialer/internal/originate/originate.go`:**

```go
consentRes, err := consent.Default.CheckConsent(ctx, consent.CheckRequest{
    TenantID:                tenant.ID,
    CampaignID:              campaign.ID,
    LeadID:                  lead.ID,
    CallUUID:                "",  // assigned by T01; backfilled by originate_audit join
    LeadState:               lead.State,                           // D03-resolved
    CallerState:             tenant.DefaultCallerState,            // tenant config
    LeadIsBusiness:          lead.IsBusiness,
    CampaignRecordingPurpose: campaign.RecordingPurpose,
    CampaignRecordingPolicy: campaign.RecordingPolicy,
    TenantMinimumMode:       tenant.ConsentMinimumMode,
    CampaignOverrideMode:    campaign.ConsentPolicyOverride,
    ConsentMsgAudioPath:     campaign.ConsentMsgAudio,
    OptOutAction:            campaign.OptOutAction,
    When:                    time.Now(),
})
if err != nil { return wrapErr(err) }

// T04 writes three channel vars on the originate string:
chanVars["vici2_consent_mode"]      = consentRes.Decision.String()
chanVars["vici2_consent_state"]     = consentRes.StateApplied
chanVars["vici2_consent_required"]  = strconv.FormatBool(consentRes.ConsentRequired)
chanVars["vici2_consent_audio"]     = consentRes.PromptAudio
chanVars["vici2_consent_opt_out"]   = consentRes.OptOutAction

// On SKIP: do NOT originate. Write originate_audit row with consent_decision=SKIP.
if consentRes.Decision == consent.ModeSkip {
    audit.WriteOriginateAudit(ctx, originate_audit{
        ..., consent_decision: "SKIP", consent_state: consentRes.StateApplied,
        block_reason: consentRes.Reason,
    })
    return ErrConsentSkip{Reason: consentRes.Reason}
}
```

### 7.2 F03 dialplan — runtime execution

F03 PLAN amendment (filed by C02 PLAN as a coordination request, not as F02-style schema change) lands these extensions in `freeswitch/conf/dialplan/default.xml`:

```xml
<extension name="recording_consent_check">
  <condition field="${vici2_consent_mode}" expression="^ALLOW$">
    <action application="set" data="consent_record_enabled=true"/>
    <action application="set" data="vici2_consent_status=not_required"/>
  </condition>
  <condition field="${vici2_consent_mode}" expression="^PROMPT_BEEP$">
    <action application="execute_extension" data="consent_beep_continuous XML default"/>
  </condition>
  <condition field="${vici2_consent_mode}" expression="^PROMPT_MESSAGE$">
    <action application="execute_extension" data="consent_message_only XML default"/>
  </condition>
  <condition field="${vici2_consent_mode}" expression="^REQUIRE_ACTIVE$">
    <action application="execute_extension" data="consent_message_active XML default"/>
  </condition>
  <condition field="${vici2_consent_mode}" expression="^SKIP$">
    <action application="set" data="consent_record_enabled=false"/>
    <action application="set" data="vici2_consent_status=skipped"/>
  </condition>
</extension>
```

The four sub-extensions (`consent_message_only`, `consent_message_active`, `consent_beep_continuous`, `recording_consent_check`) are RESEARCH §10.2 verbatim. F03's PLAN consumes this as a coordinated amendment in the same orchestrator batch as F02-amendments.

### 7.3 R01 (recording) — gating

R01 PLAN §11 already gates `record_session` on `${consent_record_enabled}`. C02 (via T04 + F03) is the writer of that var. R01.StartRecording (Go) ALSO calls back to verify `consent_status` is set on the channel BEFORE issuing `bgapi uuid_record start` — defense in depth, per R01 PLAN §10.1.

R01 PLAN §10.1 already documents the channel-var contract (table reproduced from RESEARCH §10.3):

| `vici2_consent_status` | R01 behavior |
|---|---|
| `not_required` (ALLOW) | record_session runs immediately |
| `prompted_accepted` (REQUIRE_ACTIVE, accepted) | record_session runs |
| `prompted_assumed` (PROMPT_MESSAGE) | record_session runs |
| `beep_only` (PROMPT_BEEP) | record_session runs with beep |
| `prompted_declined` (REQUIRE_ACTIVE, declined) | record_session does NOT run; if opt_out_action=hangup, hangup |
| `skipped` (SKIP) | record_session does NOT run |

**Invariant:** R01.StartRecording returns `ErrConsentMissing` if `vici2_consent_status` is unset or empty on the channel. C02's contract: every call that reaches R01 has the var set (by F03 extension or T04 inline).

---

## 8. Audit row — per-decision immutable log

### 8.1 The Sink interface

C02 does not write to MySQL directly. Same pattern as C01 (§6): push structured rows onto a Valkey Stream consumed by the api worker.

```go
type Sink interface {
    Write(ctx context.Context, row ConsentLogRow) error
}

type ConsentLogRow struct {
    Ts             time.Time
    TenantID       int64
    CallUUID       string
    LeadID         int64
    CampaignID     int64
    UserID         *int64    // agent on the call; nil pre-bridge
    LeadState      string
    CallerState    string
    Decision       string    // "ALLOW" | "PROMPT_BEEP" | "PROMPT_MESSAGE" | "REQUIRE_ACTIVE" | "SKIP"
    Mechanism      string    // e.g., "PROMPT_MESSAGE/lead=CA/caller=TX"
    StateApplied   string    // 2-letter state that drove the decision
    ConsentStatus  string    // populated post-call from R01 (mirrored from channel-var)
    Reason         string    // controlled vocab; §2.3
    RecordedAt     time.Time // = req.When at decision time
}
```

**Phase 1 implementation (`StreamSink`):** `XADD t:{tid}:audit:consent:stream * <row-json>`. The api worker (`api/workers/audit-flush.ts` — owned by C03; shared with C01's call_window_audit and T04's originate_audit) consumes with `XREADGROUP`, batches 100 rows, writes one INSERT into `consent_log`. Stream MAXLEN ≈ 100k (~2h of full-volume backlog).

**Sampling rule:** UNLIKE C01, C02 writes **every** decision (no ALLOW sampling). Rationale: each row is a defense exhibit; missing rows create gaps in the audit trail. Volume estimate at 100-agent center: ~30k calls/day = 30k rows/day. Comfortable for monthly partitioning.

**Async-not-blocking:** `Sink.Write` returns immediately on stream-add or stream-full (drop with `vici2_compliance_consent_audit_dropped_total` increment). `CheckConsent` never blocks on audit. SLO: <100µs added latency at p99.

### 8.2 What gets written when

| Trigger | When | What |
|---|---|---|
| C02.CheckConsent returns | T04 hot path | One `consent_log` row with everything except `consent_status` (which is set post-call). Status defaults to `"pending"`. |
| R01 post-call | After hangup, R01 writes recording_log | Update `consent_log` row WHERE call_uuid=? to set `consent_status` to mirror `vici2_consent_status` channel-var. **Wait — `consent_log` is INSERT-only.** Decision: emit a SECOND row with the final status, not an UPDATE. Two rows per call_uuid: decision-time + status-time. C03's compaction query groups them. |

**Alternative considered:** mutable `consent_log` table with a status update. Rejected because INSERT-only is the audit-grade pattern (RESEARCH §1.10 + F02 PLAN §4.5). Two rows per call is the immutability cost.

### 8.3 Immutability + retention (handed off to C03 + C04)

- `vici2_app_rw` gets `INSERT, SELECT` only on `consent_log` — no `UPDATE`/`DELETE` (parallel to `audit_log`, `recording_log`, `drop_log` per F02 PLAN §4.5).
- Drops only via `vici2_partition_admin` for retention rotation.
- **Retention:** 7 years (matches `audit_log`, `recording_log`, `drop_log` per F02 PLAN §6). C04 retention worker rotates partitions; archival to S3 with object-lock.

---

## 9. F02 amendment request — `consent_log` + 6 columns

This PLAN flags **one new table + six column additions** to F02-amendments. Filed as a single coordinated batch.

### 9.1 NEW table `consent_log`

```sql
CREATE TABLE consent_log (
    id              BIGINT NOT NULL AUTO_INCREMENT,
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    call_uuid       VARCHAR(40) NOT NULL,
    lead_id         BIGINT NOT NULL,
    campaign_id     VARCHAR(32) NOT NULL,
    user_id         BIGINT NULL,
    lead_state      CHAR(2) NULL,
    caller_state    CHAR(2) NULL,
    decision        ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP') NOT NULL,
    mechanism       VARCHAR(64) NOT NULL,
    state_applied   CHAR(2) NULL,
    consent_status  ENUM('pending','not_required','prompted_accepted','prompted_declined','prompted_assumed','beep_only','skipped') NOT NULL DEFAULT 'pending',
    reason          VARCHAR(64) NOT NULL,
    citation        VARCHAR(128) NULL,
    recorded_at     DATETIME(6) NOT NULL,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id, recorded_at),
    INDEX idx_tlc (tenant_id, lead_id, recorded_at),
    INDEX idx_t_call (tenant_id, call_uuid),
    INDEX idx_t_state (tenant_id, state_applied, recorded_at),
    INDEX idx_t_decision (tenant_id, decision, recorded_at)
)
ENGINE=InnoDB
PARTITION BY RANGE COLUMNS(recorded_at) (
    PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
    PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
    PARTITION p2026_07 VALUES LESS THAN ('2026-08-01'),
    PARTITION p2026_08 VALUES LESS THAN ('2026-09-01'),
    -- rolled forward by C03's partition-maintainer cron
    PARTITION pmax     VALUES LESS THAN (MAXVALUE)
);
```

- **Tenant-id-first index leadership** per F02 PLAN tenant-isolation convention (CI check enforces).
- **PRIMARY KEY** includes `recorded_at` per F02 partitioning convention.
- **Volume:** ~30k rows/day per 100-agent center; ~11M/year; ~77M over 7 years.

### 9.2 NEW columns on `tenants`

```sql
ALTER TABLE tenants
    ADD COLUMN consent_minimum_mode
        ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP')
        NOT NULL DEFAULT 'PROMPT_MESSAGE',
    ADD COLUMN default_caller_state CHAR(2) NULL;
```

### 9.3 NEW columns on `campaigns`

```sql
ALTER TABLE campaigns
    ADD COLUMN consent_policy_override
        ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP') NULL,
    ADD COLUMN recording_purpose
        ENUM('general','training','quality_control','monitoring') NOT NULL DEFAULT 'general',
    ADD COLUMN opt_out_action
        ENUM('continue_no_record','hangup') NOT NULL DEFAULT 'continue_no_record',
    ADD COLUMN consent_msg_audio VARCHAR(255) NULL;
```

### 9.4 NEW column on `leads` (coordinate with D01)

```sql
ALTER TABLE leads
    ADD COLUMN is_business TINYINT(1) NOT NULL DEFAULT 0;
```

**Note:** D01 PLAN owns the CSV-import path that populates this. C02 PLAN files the column; D01 PLAN consumes it. If D01 has already added `is_business` in their amendment, this is a no-op alignment.

### 9.5 Coordination note for orchestrator

These four schema changes ship as **one F02-amendment migration** alongside C01's `call_window_audit` amendment. Suggested batch:

```
F02 IMPLEMENT (primary)                       ← LANDED 5943a1e
  └── F02 IMPLEMENT amendment #1 (in flight) ← C02 + C01 + any other
       │  • consent_log table (C02)
       │  • call_window_audit table (C01)
       │  • state_holidays table (C01)
       │  • tenants.consent_minimum_mode, default_caller_state (C02)
       │  • campaigns.consent_policy_override, recording_purpose,
       │              opt_out_action, consent_msg_audio (C02)
       │  • campaigns.unknown_tz_policy (C01)
       │  • leads.is_business (C02, coordinate with D01)
       │  • leads.tz_blocked (C01)
       └── C01 IMPLEMENT + C02 IMPLEMENT can start
            └── C03 IMPLEMENT can start (consumes consent_log + call_window_audit)
```

---

## 10. Code structure & file layout

```
dialer/internal/compliance/consent/
  types.go               # Mode, CheckRequest, CheckResult, ConsentRule, RecordingPurpose
  check.go               # Checker, New, CheckConsent
  rules.go               # hand-written helpers + StricterOf + reason-picker
  rules_gen.go           # CODE GENERATED — var stateRules map[string]ConsentRule
  audit.go               # Sink interface, StreamSink, StdoutSink, ConsentLogRow
  metrics.go             # Prometheus collectors per §12
  reasons.go             # const strings for reason vocabulary; assert exhaustive in test
  fixtures_test.go       # 15-fixture catalog (§11.1) embedded as JSON
  check_test.go          # table-driven against fixtures; ≥95% line coverage gate
  reasons_test.go        # asserts vocabulary set is exhaustive
  benchmark_test.go      # p99<200µs benchmark gate
  doc.go                 # package docstring + cross-link to RESEARCH.md/PLAN.md

scripts/build-consent-rules/
  main.go                # generator (§3.4)

db/seeds/
  consent_rules.csv      # source-of-truth (§3.3)

freeswitch/conf/dialplan/default.xml   # F03-owned; C02 PLAN documents the contract (§7.2)
freeswitch/sounds/consent/
  default/en-US/vici2_consent_msg.wav  # default audio shipped with repo

# Phase 1.5 (not blocking C02 IMPLEMENT):
api/src/compliance/consent/
  types.ts
  rules.gen.ts           # CODE GENERATED
  check.ts               # mirror of CheckConsent
  __tests__/check.spec.ts
```

---

## 11. Test plan

### 11.1 Required acceptance fixtures (15)

| # | Name | Lead state | Caller state | LeadIsBusiness | Recording Purpose | Tenant min | Campaign override | Expected Decision | Expected Reason |
|---|---|---|---|---|---|---|---|---|---|
| 1 | TX→TX baseline 1-party | TX | TX | false | general | ALLOW | nil | ALLOW | `ok` |
| 2 | CA→CA 2-party default | CA | CA | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_both` |
| 3 | CA→TX Kearney interstate | CA | TX | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_lead` |
| 4 | TX→CA caller-state interstate | TX | CA | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_caller` |
| 5 | Campaign tries to loosen below floor | CA | TX | false | general | PROMPT_MESSAGE | ALLOW (illegal) | PROMPT_MESSAGE | `state_2party_lead` |
| 6 | PA B2B carveout, training purpose | PA | TX | true | training | PROMPT_MESSAGE | nil | ALLOW | `b2b_pa_carveout` |
| 7 | PA B2B but general purpose | PA | TX | true | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_lead` |
| 8 | FL B2B does NOT carveout | FL | TX | true | training | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_lead` |
| 9 | Tenant SKIP overrides everything | TX | TX | false | general | SKIP | nil | SKIP | `tenant_policy_skip` |
| 10 | Campaign REQUIRE_ACTIVE in 1-party | TX | TX | false | general | PROMPT_MESSAGE | REQUIRE_ACTIVE | REQUIRE_ACTIVE | `require_active_campaign` |
| 11 | Lead state unknown defaults to PROMPT_MESSAGE | "" | TX | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `lead_state_unknown` |
| 12 | Caller state unknown but lead is TX | TX | "" | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `tenant_minimum_floor` |
| 13 | Campaign recording NEVER → SKIP | CA | CA | false | general | PROMPT_MESSAGE | nil + recording_policy=NEVER | SKIP | `campaign_disabled` |
| 14 | OR conservative 2-party posture | OR | TX | false | general | PROMPT_MESSAGE | nil | PROMPT_MESSAGE | `state_2party_lead` |
| 15 | Tenant minimum REQUIRE_ACTIVE wins over state | TX | TX | false | general | REQUIRE_ACTIVE | nil | REQUIRE_ACTIVE | `require_active_tenant` |

Fixture file: `dialer/internal/compliance/consent/fixtures.json` (embedded via `embed.FS`). Same file Phase-1.5-symlinked into `api/src/compliance/consent/__tests__/fixtures.json` for TS parity.

### 11.2 Full test matrix (smoke)

`every state pair × call direction × recording mode` is combinatorially intractable, but a `TestExhaustiveStateMatrix` parametric test iterates all 51 lead-state × 51 caller-state × 4 recording_purpose × 2 LeadIsBusiness combinations against the rule matrix and asserts:
- Decision matches expected from a re-implemented reference oracle (using the CSV directly).
- StricterOf is commutative.
- `Decision >= legalFloor(lead) AND Decision >= legalFloor(caller)`.

~21,000 combinations; ~5s runtime; runs in CI.

### 11.3 Coverage targets

- `check.go`: ≥95% line.
- `rules.go`: ≥90% line.
- `audit.go` (StreamSink): ≥70% (XADD path); StdoutSink at 100%.

### 11.4 Performance

`go test -bench=BenchmarkCheckConsent -benchtime=10s` must show **mean <50µs, p99 <200µs**. Budget breakdown: 0 DB calls, pure map lookup + 4 comparisons + audit emit (async).

### 11.5 Property tests

- `StricterOf(a, b) == StricterOf(b, a)` for all Mode values.
- `StricterOf(a, StricterOf(b, c)) == StricterOf(StricterOf(a, b), c)`.
- `CheckConsent(req).Decision >= legalFloor(req.LeadState)` (monotonic in legal floor).
- `Reason` always in §2.3 vocabulary set.

### 11.6 Golden path + 5 edge cases (per spec callout)

| # | Scenario | Expectation |
|---|---|---|
| Golden | TX→TX, no overrides | ALLOW; no prompt; record_session immediate |
| Edge 1 | CA→CA, default tenant | PROMPT_MESSAGE played; record_session after prompt |
| Edge 2 | PA B2B training | ALLOW; record_session immediate; C04 1-yr retention applies |
| Edge 3 | REQUIRE_ACTIVE, customer declines (DTMF 2) + opt_out_action=hangup | F03 hangs up; no record_session; consent_log row with status=prompted_declined |
| Edge 4 | Campaign SKIP overrides 1-party state | No recording; consent_log row with decision=SKIP, reason=tenant_policy_skip or campaign override |
| Edge 5 | Unknown lead state + tenant minimum=ALLOW | Final = max(PROMPT_MESSAGE-default-for-unknown, ALLOW) = PROMPT_MESSAGE; metric `state_missing_total{side=lead}` increments |

---

## 12. Metrics surface

```
vici2_compliance_consent_check_total{decision, reason, state_applied}
   - counter; every CheckConsent invocation
   - decision ∈ {ALLOW, PROMPT_BEEP, PROMPT_MESSAGE, REQUIRE_ACTIVE, SKIP}

vici2_compliance_consent_skipped_total{reason}
   - counter; subset of above where decision=SKIP
   - high rate = legitimate tenant policy OR a misconfiguration; alert on per-tenant baseline shift

vici2_compliance_consent_state_missing_total{side="lead"|"caller"}
   - counter; PAGE-severity per O01
   - lead-side unknown is a D03/D01 data-quality issue

vici2_compliance_consent_check_duration_seconds
   - histogram; le buckets {1µs, 10µs, 100µs, 1ms}
   - SLO: p99 < 200µs

vici2_compliance_consent_audit_dropped_total{reason}
   - counter; stream-full drops; reason ∈ {stream_full, sink_error}
   - alert at >100/h per tenant

vici2_compliance_consent_b2b_applied_total{state}
   - counter; PA B2B carveouts applied (sanity tracking)
```

Cardinality: ~5 decisions × 14 reasons × 52 states ≈ 3.6k series across the whole module — within O01's per-target budget.

---

## 13. Operational playbook

### 13.1 Alert: `vici2_compliance_consent_skipped_total{reason="campaign_disabled"} > 0` after deploy

**Symptom:** unexpected SKIP rate post-deploy.
**Means:** either (a) campaign was just configured `recording_policy=NEVER` (expected) or (b) misconfiguration.

**Runbook:**
1. `SELECT id, name, recording_policy FROM campaigns WHERE recording_policy='NEVER'` — confirm intent.
2. If unintended, M02 admin flips it; new rows immediately reflect.

### 13.2 Alert: `vici2_compliance_consent_state_missing_total{side="lead"} > 100/h` (SEV2)

**Symptom:** D03 is not resolving `lead.state` for a significant slice of leads.
**Runbook:**
1. Check D03 metrics: which resolution tier is failing? ZIP missing? NPA-NXX gaps?
2. Sample leads with `lead.state IS NULL` in `consent_log` — check `leads.zip`, `leads.postal_code` populated.
3. C02 stays SAFE during this — conservative PROMPT_MESSAGE applies. Compliance is preserved; UX (added prompt) is the cost.

### 13.3 Alert: `vici2_compliance_consent_audit_dropped_total > 100/h`

**Symptom:** consent_log stream backlog or sink errors.
**Severity:** SEV1 — audit gap is a litigation exposure.
**Runbook:**
1. Check api worker (`audit-flush.ts`) health. Is it consuming? Lag on stream?
2. Check MySQL: is `consent_log` writable? Partition gap?
3. Restart api worker if necessary; backfill from Valkey Stream (XRANGE from last commit).

### 13.4 New state law passes (e.g., a 14th 2-party state)

Process:
1. Edit `db/seeds/consent_rules.csv` — add row.
2. Run `go generate ./dialer/internal/compliance/consent/...` (and `pnpm -F api gen:consent-rules` Phase 1.5).
3. Add a fixture covering the new state.
4. PR; CI gates verify codegen + fixture pass.
5. Deploy. No DB migration needed.

### 13.5 New state law tightens existing state (e.g., MA adds REQUIRE_ACTIVE requirement)

Process:
1. Edit CSV row's `minimum_mode` from `PROMPT_MESSAGE` to `REQUIRE_ACTIVE`.
2. Run codegen.
3. Update fixtures (MA-related).
4. PR; deploy.
5. Audit `consent_log` for prior MA decisions to estimate any retroactive exposure (handed to legal/ops).

---

## 14. Hand-off contracts (concrete, per-module)

### 14.1 To **T04** (originate primitive)

- Import: `import "github.com/F01-org/vici2/dialer/internal/compliance/consent"`
- Call: `consent.Default.CheckConsent(ctx, req)` as the 5th gate (after concurrent-cap, drop-rate, TCPA, DNC).
- On `Decision=SKIP`: write originate_audit row, return typed error, do NOT originate.
- On any other decision: serialize 5 channel vars per §7.1.

### 14.2 To **R01** (recording)

- Read `vici2_consent_status` channel-var (set by F03 extensions after C02's mode is executed).
- Gate `record_session` on `${consent_record_enabled}=true` (R01 PLAN §11 already specifies).
- R01.StartRecording returns `ErrConsentMissing` if `consent_status` is empty.
- Mirror `consent_status` to `recording_log.consent_status` (R01 PLAN §10.1 contract).

### 14.3 To **F03** (FreeSWITCH dialplan)

- Land four new extensions per §7.2: `recording_consent_check`, `consent_message_only`, `consent_message_active`, `consent_beep_continuous`.
- Each extension is RESEARCH §10.2 verbatim.
- Default audio file: `freeswitch/sounds/consent/default/en-US/vici2_consent_msg.wav` shipped with repo (~2s English).

### 14.4 To **F02** (schema)

- One amendment: §9.1 + §9.2 + §9.3 + §9.4. Coordinated in same batch as C01's amendment.

### 14.5 To **C03** (audit immutability)

- C03 owns `consent_log` GRANT setup (`INSERT, SELECT` only for `vici2_app_rw`; partition admin only for drops).
- C03 implements the api worker that consumes `t:{tid}:audit:consent:stream` → INSERTs.

### 14.6 To **C04** (retention)

- C04 implements 7-year retention for `consent_log` via monthly partition rotation. Same pattern as `recording_log`/`audit_log`/`drop_log`.
- C04 enforces PA §5704(15) 1-year retention for recordings flagged with `consent_log.decision=ALLOW AND reason=b2b_pa_carveout` (the recording itself; the consent_log row stays 7 years). C04 PLAN owns the logic; C02 provides the audit trail.

### 14.7 To **D01** (lead import)

- D01 CSV import populates `leads.is_business BOOLEAN` from CSV column. Default false.
- If D01 PLAN does not currently have this column, C02 PLAN's §9.4 amendment adds it. Coordinate so we don't double-add.

### 14.8 To **D03** (state resolution)

- D03 resolves `lead.state` from (in priority order): explicit `leads.state` value → `leads.postal_code` (ZIP) → NPA-NXX of `leads.phone`.
- D03 returns `state=""` if all tiers fail; C02 defaults to PROMPT_MESSAGE in that case.
- D03 is NOT involved with `caller.state` (that comes from `tenants.default_caller_state` per Phase 1).

### 14.9 To **M02** (campaign editor — UI)

- Surface four new campaign fields: `consent_policy_override`, `recording_purpose`, `opt_out_action`, `consent_msg_audio`.
- Validation: campaign editor must REJECT a `consent_policy_override=ALLOW` if any lead in the campaign is in a 2-party state (UI hint; runtime gate is in CheckConsent regardless). Admin-only (role check per A07).
- Audio upload: M02 stores in S3; D02 syncs to FS box; M02 stores the FS-local path in `consent_msg_audio` column.

### 14.10 To **M05** (tenant editor — UI)

- Surface two new tenant fields: `consent_minimum_mode`, `default_caller_state`.
- Admin-only. The audit log captures who flipped them (via A02's row-level audit, not C02's).

### 14.11 To **O01** (observability)

- O01 PLAN §3.1 already files alert rules for compliance hard floors. C02 IMPLEMENT confirms the metric names per §12 exist and are registered. Alerts wire to `consent_state_missing_total` (SEV2) and `consent_audit_dropped_total` (SEV1).

---

## 15. Risks + dependencies

### 15.1 Risk register

| Risk | Owner | Mitigation |
|---|---|---|
| State law changes mid-quarter | Ops + Legal | Codegen is mechanical: edit CSV, PR, deploy. Quarterly compliance review. |
| Court reinterprets "consent" stricter than `PROMPT_MESSAGE` | Legal | Tenants can opt up to `REQUIRE_ACTIVE`. Consent-fatigue UX cost acknowledged. |
| `lead.state` unresolved (D03 returns NULL) | C02 | Default to `PROMPT_MESSAGE` + page O01. Still legally defensible. |
| Beep alone insufficient in some courts | C02 | Default = `PROMPT_MESSAGE`, NOT beep. Beep is opt-in only. |
| Consent fatigue (every call has prompt) | UX | Acceptable cost; enterprise users tolerate ~2s. Default audio ≤ 2s. |
| Caller-state unknown | C02 | Page O01; default to lead-state-only logic (still legally safe). |
| B2B exception over-broad | Legal | PA only Phase 1; documented narrow carveout. |
| `consent_log` partition pressure (high call volume) | C03/C04 | Same partitioning posture as recording_log/audit_log; F02 pattern proven. |
| Audit gap from Sink drop | C03 | `audit_dropped_total` alert at >100/h; stream MAXLEN 100k; back-pressure visible. |
| Matrix drifts between Go and TS | C02 (Phase 1.5) | Single CSV + CI codegen check; same pattern as C01's `tcpa-rulesgen`. |
| Plaintiff subpoenas "force-record" override | C02 | No override exists below legal floor. StricterOf monotonic. Codified, tested, documented (§4.1 Step 6). |
| Recording started before C02 ran | R01 | R01.StartRecording returns ErrConsentMissing if channel-var unset. Defense in depth. R01 PLAN §10.1 contract. |

### 15.2 Dependencies (DAG)

```
D01 (leads schema, is_business)
D03 (state resolver)
        │
        └──► T04 (originate primitive)
                  │
                  ├──► C02.CheckConsent (this PLAN) ──► consent_log via Sink ──► C03 (immutability) ──► C04 (retention)
                  │
                  └──► sets channel vars
                              │
                              └──► F03 (consent dialplan extensions) ──► R01 (record_session gated)

F02 (schema)
        │
        └──► F02-amendments batch (this PLAN §9 + C01's §8)
                  │
                  └──► C02 IMPLEMENT can start
                  └──► C01 IMPLEMENT can start
                  └──► C03 IMPLEMENT can start
```

---

## 16. Acceptance criteria

- [ ] Single `CheckConsent` function used by T04 originate gate. Verified by import-graph linter.
- [ ] Stricter-state-wins (Kearney): `StricterOf(legalLead, legalCaller, tenant, campaign)` monotonic; campaign cannot loosen below legal floor. Verified by fixture #5.
- [ ] All 13 strict 2-party states return `PROMPT_MESSAGE` default. Verified by `TestExhaustiveStateMatrix` parametric.
- [ ] All 38 1-party states (+ DC + 5 territories) return `ALLOW` default. Verified by parametric.
- [ ] PA B2B carveout fires only with `recording_purpose ∈ {training, quality_control, monitoring}`. Verified by fixtures #6, #7.
- [ ] No state other than PA grants B2B exemption (Phase 1). Verified by fixture #8.
- [ ] Unknown `lead.state` → `PROMPT_MESSAGE` + metric increment. Verified by fixture #11.
- [ ] `campaigns.recording_policy=NEVER` short-circuits to `SKIP`. Verified by fixture #13.
- [ ] Tenant `SKIP` overrides everything (more-restrictive direction). Verified by fixture #9.
- [ ] Audit row written for every `CheckConsent` invocation (no sampling). Verified by integration test against StreamSink.
- [ ] `consent_log` is INSERT-only (no UPDATE/DELETE GRANTs). Verified by C03 GRANT test.
- [ ] `vici2_compliance_consent_*` metrics exported and registered. Verified by metrics endpoint scrape.
- [ ] Performance: p99 < 200µs benchmark gate.
- [ ] Code coverage ≥95% on `check.go`.
- [ ] Reason vocabulary exhaustive (no free text). Verified by `reasons_test.go`.
- [ ] F02 amendment (`consent_log` + 6 columns) lands before C02 IMPLEMENT can start.
- [ ] F03 amendment (4 dialplan extensions + default audio file) lands before R01 IMPLEMENT can mark consent flow done.
- [ ] R01.StartRecording returns `ErrConsentMissing` if `vici2_consent_status` unset. Verified by R01 integration test (R01 PLAN §10.1 contract).

---

## 17. STOP

PLAN complete. F02 amendment requested per §9 (coordinate with C01's amendment). F03 amendment requested per §7.2. No code in this PLAN. Proceed to checkpoint review; on approval, IMPLEMENT phase begins after F02-amendment + F03-amendment land.
