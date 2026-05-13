# T04 — Compliance-Gated Originate — PLAN

| Field | Value |
|---|---|
| **Module** | T04 (Telephony · Phase 1) |
| **Author** | T04-PLAN sub-agent (Claude Opus 4.7, 1M ctx) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator review. |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 40 citations behind every choice. |
| **Module spec** | `/root/vici2/spec/modules/T04.md` (superseded for the §"Goal" boundary by T01 PLAN §16; this PLAN ratifies the §16 split). |
| **Depends on (FROZEN upstream)** | T01 PLAN §7/§11/§13/§16 (ESL `Originate` transport, BACKGROUND_JOB correlation, per-FS circuit breaker + token bucket); T02 PLAN §9 (`gateways.max_concurrent` + Valkey active-call gauge); T03 PLAN §1 (`agent_t<tid>_u<uid>@default` conference helper); C01 PLAN §2 (`tcpa.Check`/`tcpa.WindowClosesWithin`); F02 PLAN §4 + **F02 AMENDMENTS A1/T04.1–T04.4** (`originate_audit` table, `lists.caller_id_override`, four new D04 statuses). |
| **Blocks** | E02 (pacing — calls T04 every dial slot), E04 (picker — calls T04 with `AgentID`), A04 (manual dial REST), A07 (transfer module — uses T04 for closer leg), N01 (Phase 4 external click-to-dial), E06 (janitor — sweeps `originate_audit WHERE outcome='OTHER'`). |

This PLAN turns the T04 RESEARCH 5-gate compliance pipeline into the exact
Go package layout, public API surface, gate signatures, channel-var schema,
audit row contract, error taxonomy, metric names, and test plan the IMPLEMENT
phase will deliver. Once approved the **public surface** —
`dialer/internal/originate` package API, `OriginateRequest` / `OriginateResult`
shapes, gRPC `T04OriginateService.Originate` proto, audit row column
contract, `attempt_uuid` single-ID rule across six tables, channel-var key
set, emitted Stream/metric names, and typed error set — is FROZEN. Gate
internals, channel-var key ordering, and retry phrasing may change without
RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **T04 is a thin policy wrapper around T01.** Per T01 PLAN §16.2 the
   T01↔T04 boundary is FROZEN: T01 owns the ESL transport (`*esl.Client.Originate`,
   reconnect, breaker, rate limiter, BACKGROUND_JOB correlation); T04 owns
   the **5 compliance gates + `originate_audit` row + channel-var assembly
   + caller-ID pick + idempotency**. T04 imports T01; T01 must never
   import T04 (CI grep). Total IMPLEMENT budget: ~450 LOC orchestration +
   ~700 LOC tests + 1 gRPC proto (~80 LOC).
2. **Five gates, fixed order, cheap-to-expensive, fail-fast, defense-in-depth.**
   (1) `gateway-cap` — Valkey `t:{tid}:gw:{gid}:active` vs `gateways.max_concurrent`
   (~150 µs); (2) `drop-cap` — campaign 30d rolling drop-rate gauge vs
   `campaigns.adaptive_drop_pct` (~150 µs; Phase 1 stubs ALLOW); (3) `tcpa`
   — `C01.Check(req)` with `EnforcementPoint=originate_path` (~1 ms cached);
   (4) `dnc` — `D05.IsDnc` Bloom + MySQL confirm (~0.7 ms p99 hot, ~1.2 ms
   with one Bloom FP); (5) `consent` — vendored 12-state matrix lookup
   (~200 ns), swappable with C02 import without API break. First BLOCK
   short-circuits; remaining gates run only if every prior gate ALLOWED.
3. **Synchronous audit insert — INSERT before T01, UPDATE once after.**
   Resolves RESEARCH §1 #10. INSERT happens **always**, even for compliance
   BLOCKs (so every attempt has TCPA evidence). For BLOCKs the row is
   INSERTed with the terminal `outcome` already set; for ALLOWs the row is
   INSERTed with `outcome='OTHER'` and UPDATEd once when BACKGROUND_JOB
   resolves (or the E06 janitor reaps it as `JOB_ORPHANED`). DAL guards
   UPDATE with `WHERE outcome='OTHER' AND outcome_at IS NULL` so no row is
   ever overwritten after finalization — matches F02 PLAN §4.x INSERT-only
   posture for TCPA-evidence tables.
4. **`attempt_uuid` is the single ID across six tables.** Generated **once**
   by the caller (E02/E04/A04/A07/N01) at intent time. The same UUIDv4
   string lowercase 36 chars `VARCHAR(40)` lands in (a) `originate_audit.attempt_uuid`
   (UNIQUE; idempotency key), (b) T01 `bgapi originate` `Job-UUID:` header,
   (c) FS channel var `origination_uuid=`, (d) Valkey
   `t:{tid}:in_flight:{call_uuid}` HASH key, (e) `call_log.uuid`,
   (f) `recording_log.uuid`. Hard requirement per SPEC §4.x + T01 PLAN §16.3
   sequence diagram. Codified in this PLAN as the **one-UUID rule**;
   CI test asserts the round-trip on a real ESL fixture.
5. **`originate_audit` row contract — 33 columns, one INSERT, one UPDATE.**
   F02 AMENDMENT A1/T04.1 already landed (`api/prisma/schema.prisma`
   §4 T04 amendment, `OriginateAudit` model; partitioned monthly
   `RANGE COLUMNS(originated_at)`; `UNIQUE (attempt_uuid, originated_at)`
   per F02's partition-column-in-every-unique-key rule). §5 of this PLAN
   pins which gate populates which column.
6. **Caller-ID is a 4-tier waterfall, Phase 1 wires tiers 1 + 4.**
   per-call override → per-list override (`lists.caller_id_override`,
   F02 AMENDMENT A1/T04.3+T04.4) → local-presence pool (X05, Phase 3.5,
   stub returns `nil` in Phase 1) → campaign default
   (`campaigns.caller_id_override`). Picker lives at
   `dialer/internal/originate/cid_picker.go` as a single function so X05
   and N05 (branded-calling) can override later without touching gates.
7. **5 typed errors, one per gate + one for transport.** `ErrTCPABlocked`,
   `ErrDNCHit`, `ErrConsentBlocked`, `ErrGatewayLimit`, `ErrRateLimited`
   (drop-cap or T01 token bucket — sub-reason distinguishes); plus
   `ErrCarrierFail` (T01 returned `ErrCircuitOpen` / `ErrFSDead` /
   `ErrJobOrphaned`). All errors implement `OriginateError` interface
   carrying `Gate`, `SubReason`, `RetryAfter time.Duration`, and the
   `AttemptUUID` so callers can release the hopper claim with the right
   D04 status.
8. **Mode → DialTarget table is fixed (RESEARCH §2.5).** PROGRESSIVE →
   CONFERENCE; PREDICTIVE → PARK; MANUAL → CONFERENCE; PREVIEW → CONFERENCE.
   `DialTarget` is in the public API for self-documenting call sites; T04
   maps to T01's `OnAnswerAction` interface internally (`OnAnswerConference{Name}`
   or `OnAnswerPark{}`). PROGRESSIVE/MANUAL/PREVIEW conference name comes
   from `conference.ConferenceFQN(tenantID, agentID, "default")` — the
   sole helper allowed to produce conference names per T03 RFC-002 lint.
9. **9 Prometheus metrics, 1 alert page-severity.** Master KPI
   `vici2_t04_originate_total{tenant,campaign,mode,outcome}`; gate
   breakdown `vici2_t04_compliance_blocked_total{gate,sub_reason}`;
   per-gate latency `vici2_t04_gate_duration_seconds{gate}`; audit insert
   latency `vici2_t04_audit_insert_latency_seconds`; idempotency-replay
   counter `vici2_t04_idempotent_replays_total`; bypass-token redemptions
   `vici2_t04_dnc_bypass_token_redeemed_total`; in-flight gauge
   `vici2_t04_inflight`; local-presence miss counter
   `vici2_t04_local_presence_miss_total{npa_nxx}`; carrier-fail counter
   `vici2_t04_carrier_fail_total{fs_host,reason}`. PAGE on
   `vici2_t04_compliance_blocked_total{gate="tcpa"}` rate > 5 σ over 1h
   (E01 hopper-filler is broken or campaign config drifted).
10. **gRPC service `T04OriginateService.Originate` lives in
    `shared/proto/dialer.proto`** so api (Node, for A04 manual-dial)
    and the future N01 REST gateway can call T04 cross-process. E02
    and E04 (Go) import the package directly — no gRPC hop in the
    pacing-loop hot path. Same protobuf request shape for both paths.

---

## 1. Goals + non-goals

### 1.1 Goals

- **Run the 5-gate compliance pipeline** for every outbound originate request,
  in the FROZEN order of §3 (gateway-cap → drop-cap → tcpa → dnc → consent),
  short-circuiting on the first BLOCK.
- **Insert one `originate_audit` row per attempt** — pass or block — keyed
  by the caller-supplied `attempt_uuid`. Row contains every gate decision
  + outcome + correlation IDs (lead, campaign, agent, list, carrier,
  gateway, FS host, request_id, ip_address).
- **Translate `OriginateRequest` → T01 transport call** by (a) picking the
  caller-ID via the 4-tier waterfall, (b) assembling the 16-key channel-var
  map (§4), (c) choosing the right `OnAnswerAction` from `DialTarget`,
  (d) handing all of that to `T01.Client.Originate` with `attempt_uuid` as
  both `Job-UUID` and `origination_uuid`.
- **Provide idempotent retry semantics** via the `UNIQUE (attempt_uuid)`
  audit-row check: replays return the prior decision/result without
  re-running gates.
- **Expose a stable Go SDK** (`dialer/internal/originate.Originate`) for
  in-process Go callers (E02/E04) and a stable gRPC service
  (`T04OriginateService.Originate`) for cross-process callers (api A04,
  Phase 4 N01).
- **Emit the metric set in §9** so SEV1 alerts fire when gate fail-rates
  spike.

### 1.2 Non-goals (explicit hand-offs to other modules)

- **WHEN to dial** — owned by E02 (pacing) / E04 (picker). T04 receives
  ready-to-dial requests; T04 never originates spontaneously.
- **ESL transport, reconnect, breaker, BACKGROUND_JOB correlation, per-FS
  token bucket** — owned by T01. T04 calls `T01.Originate` and consumes
  typed errors.
- **TCPA window math, DST handling, state holidays** — owned by C01. T04
  calls `tcpa.Check`.
- **DNC Bloom filter, federal/state/internal sources, bypass-token mint** —
  owned by D05. T04 calls `dnc.IsDnc` and validates the bypass token via
  `dnc.RedeemBypassToken`.
- **Recording-consent state matrix when C02 lands** — Phase 1 T04 vendors
  the 12-state matrix; Phase 1.5 C02 import swaps in (same `ConsentDecision`
  enum surface; no T04 API change).
- **`record_session` dialplan call** — owned by R01 reading
  `vici2_consent_required` / `vici2_recording_mode` channel vars T04
  sets. T04 sets policy; R01 acts.
- **Hopper claim release** — owned by E01. T04 returns typed errors;
  callers (E02/E04/A04) call `hopper.Release(claimToken, reason, retryAfter)`
  themselves.
- **Multi-FS host affinity (`FSHost` selection)** — owned by X03 (Phase 3.5).
  Phase 1 T04 leaves `req.FSHost=""` and lets T01 round-robin.
- **Post-answer agent assignment for PREDICTIVE** — owned by E04. T04
  initiates the PARK originate; E04 subscribes to
  `events:vici2.call.answered` and issues `T01.UUIDTransfer` directly
  (T04 never re-enters the call path post-originate). T01 PLAN §17.5
  addendum permits direct T01 calls for E04 — confirmed.

### 1.3 What changed vs. RESEARCH

| RESEARCH open question | PLAN decision |
|---|---|
| §11 Q1 sync vs async audit insert | **Synchronous.** §6 below. |
| §11 Q2 `lists.caller_id_override` exists? | **Yes** — landed in F02 AMENDMENT T04.3+T04.4; schema.prisma line 416–417. |
| §11 Q3 D04 statuses for new failure modes | **Add 4 new system statuses** (campaign_id='__SYS__') seeded by F02 amendment T04.2: `TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`. Confirmed in `api/prisma/schema.prisma` header comment. |
| §11 Q4 safe_harbor_window_ms default | **1800 ms** with 200 ms safety margin under FCC 2000 ms TSR. Per-campaign override deferred (E05 territory). |
| §11 Q5 C02 stub vendoring | **Vendor + swap.** §3.5 below. |
| §11 Q6 bypass-token auth | **Token carries actor_user_id**; T04 verifies actor has `dnc:bypass` permission via F05 RBAC; redemption audit-logs both attempts and grants (D05/C03 territory). |
| §11 Q7 stricter-state-wins consent | **Stricter-state-wins** for interstate calls. §3.5. |
| §11 Q8 dial_target=PARK + execute_on_answer=park redundancy | **Canonical: `execute_on_answer=park`** (explicit). T01 PLAN §7.3 already issues the trailing `&park()` universally; the var is the engine-side trigger. Document keeps both. |
| §11 Q9 multi-FS routing | **Phase 1: `req.FSHost=""`** → T01 round-robin. X03 wires affinity later. |
| §11 Q10 drop-rate source of truth | **Phase 1: stub ALLOW.** E03 (adaptive engine) defines the Valkey gauge later; gate signature is in place. |
| §11 Q11 PROGRESSIVE answer-time TCPA recheck | **Skip.** Only PREDICTIVE re-runs C01 at CHANNEL_ANSWER (the variable-gap-to-bridge case). PROGRESSIVE's ~50 ms gap is below any TCPA window boundary that would flip. |
| §11 Q12 lead-locked-out-after-N-failures | **Out of T04 scope.** Exposed via audit row data; E01/D04 own per-lead failure counts. |

---

## 2. Module scope (what's in / what's out)

### 2.1 In scope (this PLAN's deliverable)

- The Go package `dialer/internal/originate/` with:
  - `Originate(ctx, req OriginateRequest) (*OriginateResult, error)` public entry point
  - 5 gate functions (`gateGatewayCap`, `gateDropCap`, `gateTCPA`, `gateDNC`, `gateConsent`)
  - Caller-ID picker (`PickCallerID`)
  - Channel-var assembler (`buildChannelVars`)
  - Audit-row writer (`insertAuditRow`, `finalizeAuditRow`)
  - Typed error set (`OriginateError` + concrete types)
  - Metric collectors
- The gRPC service `T04OriginateService` in `shared/proto/dialer.proto`
  (Originate RPC; same protobuf message used by api A04 + future N01).
- A janitor entrypoint `SweepOrphans(ctx)` that E06 calls every 60 s to
  reap audit rows with `outcome='OTHER' AND originated_at < NOW() - 5 min`.
- Test fixtures: 4 modes × 6 outcomes = 24 base scenarios + 13 consent
  state fixtures + 5 idempotency-replay fixtures.

### 2.2 Out of scope (handed off)

- ESL transport (T01).
- TCPA window math (C01).
- DNC sources + bypass token mint (D05).
- Consent state matrix expansion when more states adopt 2-party law (C02).
- Hopper claim release (E01).
- Pacing decision when to dial (E02).
- Agent picker pre-dial + post-answer-transfer (E04).
- Multi-FS affinity (X03 Phase 3.5).
- Local-presence DID rotation (X05 Phase 3.5).
- Branded-calling STIR/SHAKEN token emission (N05 Phase 4).
- Carrier-side hangup-cause → D04 status mapping (D04).
- Drop-rate counter computation (E03 Phase 2).
- `record_session` execution (R01).
- `audit_log` immutability + retention (C03).

---

## 3. The 5 gates — order, semantics, BLOCK reason, retry hint

Order is **cheap → expensive**, with TCPA and DNC last because they are
the regulatory hard floors and we want every cheaper sanity check to short-
circuit before we burn a Valkey/gRPC roundtrip. Order is FROZEN; changing
it requires an RFC because it affects forensic-audit invariants
(`originate_audit.tcpa_decision` is NULL when an earlier gate blocked).

### 3.1 Step 1 — `gateway-cap` (per-gateway concurrent-call ceiling)

| Field | Value |
|---|---|
| Source | T02 PLAN §9 — Valkey gauge `t:{tid}:gw:{gateway_id}:active`, written by T01 event consumer on `CHANNEL_CREATE` / `CHANNEL_HANGUP_COMPLETE`. |
| Ceiling | `gateways.max_concurrent` (F02 §4.21 + T02 AMENDMENT add) — cached in process at construction time via T02's gateway-event Stream subscription. |
| Budget | ~150 µs (one Valkey INCR-then-compare; gateway row is in-memory). |
| Pass condition | `active < max_concurrent`. |
| Block reason | `GATEWAY_LIMIT` (no sub-reason). |
| Retry hint | `RetryAfter=0s` — caller (E02) should try a sibling gateway via T02 ordering or wait one pacing tick. |
| `originate_audit` columns set | `outcome='GATEWAY_LIMIT'`, `carrier_id`, `gateway_id`, `gateway_name` (the gateway that was full). Other gate columns (tcpa_*, dnc_*, consent_*) stay NULL. |
| D04 lead status on block | `GATEWAY_LIMIT_TRY_LATER` (F02 AMENDMENT T04.2 seed). Lead returns to hopper for immediate retry on a sibling. |

**Why first:** Gateway saturation is the single most common BLOCK at full
CPS. Hitting it ~150 µs in is cheaper than ~1 ms for TCPA + ~1 ms for DNC.

### 3.2 Step 2 — `drop-cap` (FCC 3% rolling safe-harbor ceiling per campaign)

| Field | Value |
|---|---|
| Source | E03 (Phase 2 adaptive engine) — Valkey gauge `t:{tid}:campaign:{cid}:drop_rate_30d`, computed by E03 from the F04-frozen `t:{tid}:campaign:{cid}:drop_window` Stream that T01 PLAN §10.3 writes to. **Phase 1 stubs ALLOW.** |
| Ceiling | `campaigns.adaptive_drop_pct` (F02 §4.6; default 1.50). |
| Budget | ~150 µs (Valkey GET on gauge key). |
| Pass condition | `drop_rate < adaptive_drop_pct`. |
| Block reason | `RATE_LIMITED` (sub `DROP_CAP`). |
| Retry hint | `RetryAfter = campaign.recover_seconds` (configurable; default 300 s — gives the rolling window time to age out). |
| `originate_audit` columns set | `outcome='RATE_LIMITED'`, `error_message='drop_cap:<measured>%>=<limit>%'`. |
| D04 lead status on block | unchanged — lead goes back to hopper unchanged (pacing problem, not lead problem). |

**Why second:** Still Valkey-only. Same budget tier as gateway-cap.
Placement after gateway-cap because campaign-level rate-limit is broader
than per-gateway saturation; pacing usually fixes gateway saturation
faster.

**Phase 1 behavior:** `gateDropCap` returns ALLOW unconditionally and emits
`vici2_t04_gate_duration_seconds{gate="drop_cap",stubbed="true"}`. Interface
is in place so E03 swap is mechanical.

### 3.3 Step 3 — `tcpa` (called-party-local-time window via C01)

| Field | Value |
|---|---|
| Source | C01 PLAN §2 `tcpa.Check(ctx, req)` — Go SDK (in-process call; no gRPC hop). |
| Inputs | `LeadID`, `PhoneE164`, `KnownTimezone` (from `leads.known_timezone`), `Zip` (from `leads.postal_code`), `State` (from `leads.state`), `CampaignID`, `CampaignWindow` (from `campaigns.call_time_id` resolved row), `UnknownTzPolicy` (per-campaign), `EnforcementPoint=PointOriginate`, `When=time.Now()`, `IsAutoDialer=true` if `campaigns.dial_method != MANUAL`. |
| Budget | ~1 ms cached (D03 timezone cache hit), ~5 ms cold (D03 NPA-NXX lookup). |
| Pass condition | `result.Outcome == tcpa.OutcomeAllow`. |
| Block reasons | `TCPA_BLOCKED` with sub-reason = `result.Reason` from C01's controlled vocabulary (`before_window`, `after_window`, `state_sunday_blackout`, `state_holiday_blackout`, `no_timezone`, `state_autodialer_window`, `boundary_30s_to_close`). |
| Retry hint | If `result.NextOpen != nil`: `RetryAfter = result.NextOpen - now`; else `RetryAfter = 24h` (let E01 re-queue tomorrow). |
| `originate_audit` columns set | `outcome='TCPA_BLOCKED'`, `tcpa_decision=BLOCK`, `tcpa_reason=<sub-reason>`, `tcpa_tz_resolved=result.TzIANA`. On ALLOW: `tcpa_decision=ALLOW`, `tcpa_reason=ok`, `tcpa_tz_resolved=result.TzIANA`. |
| D04 lead status on block | `TCPA` (F02 AMENDMENT T04.2 seed). Lead released with `RetryAfter` so E01 re-queues at the next open time. |

**Why third:** First non-Valkey check. Defense-in-depth — E01 hopper filler
already ran C01 at hopper-fill time, but per C01 RESEARCH §7.2 "time
elapsed between hopper insert and dial can cross the 9pm boundary on busy
systems". This is the **regulatory** check.

### 3.4 Step 4 — `dnc` (federal + state + internal final scrub via D05)

| Field | Value |
|---|---|
| Source | D05 Go SDK `dnc.IsDnc(ctx, lead.tenant_id, phone, lead.state, campaign.id) (bool, []string, error)`. |
| Sources checked | `federal`, `state` (scoped by `lead.state`), `internal` (per-tenant), `litigator` (Phase 2). Order/de-dup is D05's responsibility. |
| Budget | ~0.7 ms p99 (Bloom all-negative); ~1.2 ms p99 with one Bloom false positive (one MySQL confirm); max ~5 ms over all four sources cold. |
| Pass condition | `dncHit == false`. |
| Bypass | If `req.BypassToken != ""`, T04 calls `dnc.RedeemBypassToken(ctx, token, tenantID)` which atomically `SET NX EX 60`s the Valkey token, returning `(actorUserID, error)`. If valid: `gateDNC` returns ALLOW and writes `originate_audit.bypass_token=<token>`. Token redemption emits a `audit_log` row (C03 territory). |
| Block reason | `DNC_BLOCKED` with sub-reason = comma-joined source list (e.g., `federal,internal`). |
| Retry hint | `RetryAfter = 0`; lead is permanently DNC, should not re-queue. |
| `originate_audit` columns set | `outcome='DNC_BLOCKED'`, `dnc_decision=BLOCK`, `dnc_sources=JSON_ARRAY(<sources>)`. On ALLOW: `dnc_decision=ALLOW`, `dnc_sources=NULL`. |
| D04 lead status on block | `DNC` (existing F02 seed). |

**Why fourth:** Cheaper than C01 hot, more expensive cold. Placement after
C01 reflects that DNC-list false-positives are rare; in steady-state most
DNC checks are Bloom-clean (~0.7 ms) but they pay 4× the per-call gRPC
hop cost of `tcpa.Check` (D05 SDK is in-process Go, but Bloom is per-source
and four sources are scanned).

### 3.5 Step 5 — `consent` (per-state recording-consent policy)

| Field | Value |
|---|---|
| Source — Phase 1 | `dialer/internal/originate/consent.go` (vendored) — `func CheckConsent(opts CheckOpts) ConsentDecision`. |
| Source — Phase 1.5 | C02 import (same signature). T04 swaps the import; no API surface change. |
| Inputs | `CalledPartyState` (from `leads.state`), `CallerState` (from agent or campaign config; nullable), `CampaignPolicy` (from `campaigns.recording_mode`: `NEVER` → SKIP_RECORDING; `ONDEMAND`/`ALL` → matrix lookup; `ALLFORCE` → matrix lookup with PROMPT fallback for 2-party states — "force" never overrides law). |
| Budget | ~200 ns (in-process map lookup). |
| State matrix | 12 two-party-consent states return PROMPT: CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA. All others return ALLOW. **Interstate rule: stricter-state-wins** — if either CalledPartyState or CallerState is 2-party, return PROMPT. |
| Pass condition | `decision != ConsentBlock` (ConsentBlock is reserved for future states that ban outbound recording entirely; no current US state triggers it; gate effectively always passes in Phase 1). |
| `consent_decision` outputs | `ALLOW` (1-party, recording proceeds without prompt); `PROMPT` (2-party, R01 dialplan will play "this call may be recorded" beep + DTMF opt-out before bridging); `SKIP_RECORDING` (campaign says NEVER or operator policy overrides matrix); `BLOCK` (reserved). |
| Block reason | `CONSENT_BLOCKED` (when `decision == ConsentBlock`). |
| `originate_audit` columns set | `consent_decision=<ALLOW|PROMPT|SKIP_RECORDING|BLOCK>`, `consent_state=<2-letter>`. |
| D04 lead status on block | `CONSENT_NOT_OBTAINED` (F02 AMENDMENT T04.2 seed). |

**Why fifth:** Cheapest of all gates (in-process map lookup). But logically
last because its result is **carried forward** as a channel var
(`vici2_consent_required`, `vici2_consent_state`) rather than just a
pass/fail — doing it last lets us avoid setting the var on calls that
BLOCK earlier (smaller wire form, cleaner forensic).

### 3.6 Gate interface (uniform shape — Go signature)

```go
// dialer/internal/originate/gate.go
package originate

// Gate represents one compliance check. Each Gate evaluates a request and
// returns either ALLOW (with optional decision metadata to stamp onto the
// audit row) or BLOCK (with a typed OriginateError carrying gate name,
// sub-reason, retry hint, and the partial audit row).
type Gate interface {
    Name() string                                   // "gateway_cap", "drop_cap", "tcpa", "dnc", "consent"
    Check(ctx context.Context, req *OriginateRequest, scratch *GateScratch) GateResult
}

type GateResult struct {
    Outcome    GateOutcome   // GateAllow | GateBlock
    Block      *OriginateError  // populated iff Outcome == GateBlock
    AuditPatch AuditRowPatch // gate-specific columns to merge onto the audit row
}

type GateOutcome int
const (
    GateAllow GateOutcome = iota
    GateBlock
)

// GateScratch carries side-band state across gates within one Originate call.
// Examples: D03 tz resolution cached from C01 to avoid re-resolution; the
// chosen caller-ID + source from PickCallerID to stamp on audit; gateway ID
// resolved from carrier+priority pick to feed into channel-var assembly.
type GateScratch struct {
    CallerID         string
    CallerIDName     string
    CallerIDSource   OriginateCidSource
    ResolvedCarrierID int64
    ResolvedGatewayID int64
    ResolvedGatewayName string
    TcpaTzIANA       string
    ConsentDecision  ConsentDecision
}
```

The five concrete gate types live in
`dialer/internal/originate/gates/{gateway_cap,drop_cap,tcpa,dnc,consent}.go`
and embed the dependencies they need (T02 gauge reader, C01 checker, D05
SDK, vendored consent matrix). The `Originate` driver iterates the gate
slice in fixed order, short-circuits on first `GateBlock`, and merges
`AuditPatch` into the audit row after each step.

---

## 4. Originate scenarios — 4 modes, 2 DialTarget wire patterns

Mode → DialTarget mapping (FROZEN, mirrors RESEARCH §2.5):

| Mode | DialTarget | T01 `OnAnswerAction` | Why |
|---|---|---|---|
| `PROGRESSIVE` | `CONFERENCE` | `OnAnswerConference{Name: conference.ConferenceName(tenantID, agentID)}` | Agent is dedicated; latency-optimal; bridge on answer. |
| `PREDICTIVE` | `PARK` | `OnAnswerPark{}` | Agent not yet picked; E04 will issue `T01.UUIDTransfer` after CHANNEL_ANSWER. |
| `MANUAL` | `CONFERENCE` | `OnAnswerConference{...}` | Agent clicked Dial; identical wire to PROGRESSIVE. |
| `PREVIEW` | `CONFERENCE` | `OnAnswerConference{...}` | Same as MANUAL post-confirm; preview state lives in A04/M02 UI. |

**Conference name source:** always `conference.ConferenceFQN(tenantID, agentID, "default")`
per T03 PLAN §1.2. T04 never assembles `"agent_…"` strings — RFC-002 lint
enforces.

**Wire-form examples** (T01 produces the actual `bgapi` line; T04 just
hands T01 the `OriginateRequest`):

```
# PROGRESSIVE: customer → conference on answer
bgapi originate {
  origination_uuid=<attempt_uuid>,
  vici2_attempt_uuid=<attempt_uuid>,
  origination_caller_id_number=+12125550100,
  origination_caller_id_name=ACME,
  effective_caller_id_number=+12125550100,
  sip_from_user=+12125550100,
  ignore_early_media=true,
  originate_timeout=22,
  call_timeout=22,
  hangup_after_bridge=true,
  execute_on_answer=transfer:agent_t1_u42@default XML default,
  vici2_tenant_id=1, vici2_lead_id=1234567, vici2_campaign_id=SOLAR_Q2,
  vici2_agent_id=42, vici2_carrier_id=7, vici2_gateway_id=11,
  vici2_consent_required=true, vici2_consent_state=CA,
  vici2_recording_mode=ALL, RECORD_STEREO=true,
  sip_h_X-Vici2-Lead=1234567, sip_h_X-Vici2-Campaign=SOLAR_Q2,
  sip_h_X-Vici2-Attempt=<attempt_uuid>
}sofia/gateway/twilio_main/+14155550199 &park()
Job-UUID: <attempt_uuid>

# PREDICTIVE: customer → parked, E04 transfers after agent claim
bgapi originate {
  ... (same correlation vars, same caller-ID, no execute_on_answer transfer)
  execute_on_answer=park,
  ...
}sofia/gateway/twilio_main/+14155550199 &park()
Job-UUID: <attempt_uuid>
```

For PREDICTIVE the post-answer flow is owned by E04: it subscribes to
`events:vici2.call.answered` consumer group `picker`, claims an agent
from `t:{tid}:agents:ready` ZSET, issues `T01.UUIDTransfer(callUUID,
"conference:agent_t<tid>_u<aid>@default", "inline", "default")`. T04 is
out of the call path after the originate INSERT-and-call.

---

## 5. `originate_audit` row contract — column-by-column

F02 AMENDMENT T04.1 already created the table; this section pins **which
gate populates which column** so the IMPLEMENT phase has zero ambiguity.

| Column | Type | Populated by | Notes |
|---|---|---|---|
| `id` | BIGINT AUTO_INC | MySQL | Part of composite PK `(id, originated_at)`. |
| `tenant_id` | BIGINT | `Originate` driver | From `req.TenantID`. |
| `attempt_uuid` | VARCHAR(40) | Caller (E02/E04/A04/A07/N01) | Generated **once** at intent time. UNIQUE per `(attempt_uuid, originated_at)`. |
| `call_uuid` | VARCHAR(40) NULL | Driver after T01 success | **Equal to `attempt_uuid` by policy** (the one-UUID rule); kept distinct for forward-compat. Set only on ALLOW path. |
| `lead_id` | BIGINT | Driver | From `req.LeadID`. |
| `campaign_id` | VARCHAR(32) NULL | Driver | From `req.CampaignID`. |
| `list_id` | BIGINT NULL | Driver | From `req.ListID`. |
| `agent_id` | BIGINT NULL | Driver | From `req.AgentID`. 0/NULL for PREDICTIVE pre-answer. |
| `mode` | ENUM | Driver | From `req.Mode`. |
| `dial_target` | ENUM | Driver | Derived from `req.Mode` via the §4 mapping. |
| `carrier_id` | BIGINT NULL | `gateGatewayCap` (via `GateScratch.ResolvedCarrierID`) | Resolved during gateway pick. |
| `gateway_id` | BIGINT NULL | `gateGatewayCap` | Resolved during gateway pick. |
| `gateway_name` | VARCHAR(64) NULL | `gateGatewayCap` | Denormalized for forensic (carrier may be deleted later). |
| `caller_id_number` | VARCHAR(16) NULL | `PickCallerID` (before gate 1) | E.164. |
| `caller_id_source` | ENUM NULL | `PickCallerID` | `per_call` / `per_list` / `local_presence` / `campaign_default`. |
| `phone_e164` | VARCHAR(16) | Driver | From `req.DestNumber`. |
| `originated_at` | DATETIME(6) | Driver | `time.Now().UTC()` at INSERT; partition column. |
| `tcpa_decision` | ENUM NULL | `gateTCPA` | `ALLOW` / `BLOCK` / `SKIP` (skip if earlier gate blocked). NULL if gates 1 or 2 blocked. |
| `tcpa_reason` | VARCHAR(64) NULL | `gateTCPA` | C01 controlled-vocab string. |
| `tcpa_tz_resolved` | VARCHAR(64) NULL | `gateTCPA` | `result.TzIANA`. |
| `dnc_decision` | ENUM NULL | `gateDNC` | `ALLOW` / `BLOCK`. |
| `dnc_sources` | JSON NULL | `gateDNC` | Array of source names on BLOCK; NULL on ALLOW. |
| `consent_decision` | ENUM NULL | `gateConsent` | `ALLOW` / `PROMPT` / `SKIP_RECORDING` / `BLOCK`. |
| `consent_state` | CHAR(2) NULL | `gateConsent` | Called-party state. |
| `bypass_token` | VARCHAR(64) NULL | `gateDNC` if `req.BypassToken != ""` | The redeemed token; ties to the `audit_log` entry. |
| `outcome` | ENUM | Driver | Initial INSERT: terminal value for BLOCKs, `OTHER` for the ALLOW path; UPDATEd once when BACKGROUND_JOB resolves. |
| `outcome_at` | DATETIME(6) NULL | Driver UPDATE | Set on finalize-UPDATE. |
| `duration_ms` | INT NULL | Driver UPDATE | `outcome_at - originated_at` in ms. |
| `error_message` | TEXT NULL | Driver | Truncated `error.Error()` (max 1024 chars) on transport/carrier fail; sub-reason details on rate-limit / drop-cap. |
| `fs_host` | VARCHAR(64) NULL | Driver | Set after T01 picks the FS (echoed via T01's `OriginateResult.FSHost` — T01 PLAN §16 to confirm extension; if unavailable in v1 leave NULL). |
| `request_id` | VARCHAR(64) NULL | Driver | From gRPC metadata / Go ctx value `vici2.RequestID`. |
| `ip_address` | VARCHAR(45) NULL | Driver | From gRPC peer (for A04 manual dial: the agent's browser IP). |
| `created_at` | DATETIME(6) | DB DEFAULT | |
| `updated_at` | DATETIME(6) | DB ON UPDATE | |

**INSERT-time outcome values:** terminal for BLOCK paths
(`GATEWAY_LIMIT` / `RATE_LIMITED` / `TCPA_BLOCKED` / `DNC_BLOCKED` /
`CONSENT_BLOCKED`); `OTHER` for the ALLOW path which proceeds to
`T01.Originate`.

**UPDATE-time outcome values** (single-shot, guarded by
`WHERE outcome='OTHER' AND outcome_at IS NULL`):
`SUCCESS` | `GATEWAY_FAIL` | `TIMEOUT` | `JOB_ORPHANED`.

**Idempotency replay:** before INSERT, T04 does
`SELECT outcome, call_uuid FROM originate_audit WHERE attempt_uuid=?`
inside the same tx. If a row exists with `outcome != 'OTHER'`: return
the prior `OriginateResult` without re-running gates. If `outcome='OTHER'`:
return `ErrInProgress` so the caller can poll/wait. Documented in §8.

---

## 6. Audit-row write timing (sync INSERT, sync UPDATE)

Resolves RESEARCH §11 Q1.

### 6.1 INSERT timing

The audit row is INSERTed **inside `T04.Originate` before
`T01.Originate` is called**. INSERT happens after gate evaluation
finishes (either all 5 ALLOW or first BLOCK short-circuits), so the
INSERT always carries the final gate-decision columns.

```
T04.Originate(req):
  1. PickCallerID -> scratch.CallerID, .Source
  2. for each gate in [gateway_cap, drop_cap, tcpa, dnc, consent]:
       result := gate.Check(req, scratch)
       merge result.AuditPatch into auditRow
       if result.Outcome == GateBlock:
         auditRow.outcome = block.Outcome  // terminal
         INSERT auditRow  (sync, single-row)
         return nil, block.Err
  3. // All ALLOW. Build channel vars + OriginateRequest for T01.
  4. auditRow.outcome = OriginateOutcome.OTHER  // provisional
     INSERT auditRow                            // sync, single-row, ~3 ms p99 on the partitioned table
  5. callUUID, err := T01.Client.Originate(ctx, t01Req)
  6. if err != nil:
       UPDATE auditRow SET outcome=mapT01Err(err), outcome_at=NOW(6),
             duration_ms=..., error_message=err.Error()
         WHERE id=auditRow.id AND originated_at=auditRow.originated_at
           AND outcome='OTHER' AND outcome_at IS NULL
       return nil, ErrCarrierFail{...}
  7. UPDATE auditRow SET outcome='SUCCESS', call_uuid=callUUID, outcome_at=NOW(6),
                         duration_ms=..., fs_host=...
        WHERE id=auditRow.id AND originated_at=auditRow.originated_at
          AND outcome='OTHER' AND outcome_at IS NULL
  8. return &OriginateResult{AttemptUUID: req.AttemptUUID, CallUUID: callUUID, ...}, nil
```

### 6.2 Why synchronous

Per F02 PLAN §2.2: "telephony writes are TCPA evidence — `innodb_flush_log_at_trx_commit=1` NOT NEGOTIABLE". Async to a Stream would risk in-flight loss on Valkey crash before flush. The ~3 ms INSERT cost is acceptable at 100-CPS (~300 ms/s aggregate database time across all originate workers, well within F02's budget). The UPDATE costs ~1 ms p99 on the PK lookup.

### 6.3 Read-after-write SLA

Callers (E02, E04, A04) that hit `ErrCarrierFail` and want to read back the audit row for forensic logging: read-after-write is guaranteed because both INSERT and UPDATE complete before the function returns. There is no eventual consistency window.

### 6.4 Idempotent replay (`UNIQUE (attempt_uuid, originated_at)`)

Per F02 PLAN partitioning rule, the UNIQUE key includes the partition column. T04 implements idempotency via a `SELECT...FOR UPDATE` inside a transaction:

```
BEGIN;
  SELECT id, outcome, call_uuid, originated_at FROM originate_audit
    WHERE attempt_uuid = ?
      AND originated_at >= NOW() - INTERVAL 35 DAY  -- bounded scan to active+previous partition
    FOR UPDATE;
  -- 0 rows: continue with INSERT below
  -- 1 row, outcome != OTHER: COMMIT, return prior result (idempotent replay)
  -- 1 row, outcome == OTHER: COMMIT, return ErrInProgress
COMMIT;
```

`UNIQUE (attempt_uuid, originated_at)` enforces no two rows ever share an attempt_uuid in the same partition month; UUIDv4 collision across months is statistically impossible (~10⁻¹⁸ per year at 100 CPS). The 35-day scan window matches T01 in-flight HASH TTL (24 h) with a 10-day forensic-replay safety margin.

### 6.5 E06 janitor reaping

Audit rows with `outcome='OTHER' AND originated_at < NOW() - INTERVAL 5 MINUTE` are orphaned (T04 crashed between INSERT and UPDATE, or T01 BACKGROUND_JOB never arrived and the 60s timeout fired but the UPDATE write was lost). E06 runs `T04.SweepOrphans(ctx)` every 60 s:

```go
// dialer/internal/originate/janitor.go
func SweepOrphans(ctx context.Context, db *sql.DB, esl *esl.Client) (int, error) {
  // 1. Find candidates.
  rows, err := db.Query(`SELECT id, originated_at, attempt_uuid, call_uuid
     FROM originate_audit
     WHERE outcome='OTHER' AND originated_at < ? AND originated_at >= ?
     LIMIT 1000`, time.Now().Add(-5*time.Minute), time.Now().Add(-35*24*time.Hour))
  // 2. For each: cross-check FS via esl.Reconcile (T01 PLAN §14.1) to see if a channel exists.
  // 3. If channel exists: leave for next sweep.
  // 4. If no channel: UPDATE outcome='JOB_ORPHANED', outcome_at=NOW(6), error_message='reaped_by_janitor'.
}
```

---

## 7. `attempt_uuid` lifecycle — the one-UUID rule

**Hard requirement** (SPEC §4.x + T01 PLAN §16.3): a single UUIDv4 (lowercase, hyphenated, 36 chars; `VARCHAR(40)`) flows through six tables and three runtime stores.

### 7.1 Generation site

Always the **caller**, never T04. Five canonical callers:

| Caller | Where the UUID is generated | Why |
|---|---|---|
| E02 (pacing) | At the moment pacing decides "I'm about to dial slot X for campaign Y" — one UUID per dial slot. | One UUID per **intent**; double-fires from replicas dedupe at the audit-row UNIQUE. |
| E04 (picker) | At the moment picker decides "agent X gets the next dial" — for PROGRESSIVE mode. | Same. |
| A04 (manual dial) | When the agent UI confirms the dial click — A04's REST endpoint generates it server-side. | Browser retries get dedup'd. |
| A07 (transfer) | When the agent opens a 3-way transfer to a closer — A07 generates per closer-leg. | Each transfer leg is a separate attempt. |
| N01 (external REST, Phase 4) | The integrator passes `Idempotency-Key` HTTP header which becomes the `attempt_uuid`. | Stripe/Amazon Connect-style external idempotency contract. |

### 7.2 Propagation (one ID, six locations)

| Role | Location | Set by |
|---|---|---|
| Idempotency key | `originate_audit.attempt_uuid` UNIQUE | T04 INSERT |
| Pre-supplied FS `Job-UUID:` header | ESL `bgapi originate` header | T04 → T01 via `OriginateRequest.PreSuppliedJobID = req.AttemptUUID` |
| Pre-supplied FS channel UUID | Channel var `origination_uuid=<uuid>` | T04 → T01 via `OriginateRequest.PreSuppliedUUID = req.AttemptUUID` |
| Live state | Valkey HASH `t:{tid}:in_flight:{call_uuid}` (T01 PLAN §11.2) | T01 ESL bridge event consumer |
| CDR row | `call_log.uuid` | T01 (CHANNEL_CREATE → INSERT) |
| Recording row | `recording_log.uuid` | R01 (RECORD_START → INSERT) |

**By policy: all six are the same string.** This was suggested in T01 PLAN §16.3 sequence diagram and is **codified here** as the one-UUID rule.

### 7.3 Validation

CI integration test in `dialer/internal/originate/integration_test.go`:

```go
func TestOneUUIDRule_RoundTrip(t *testing.T) {
  attemptUUID := uuid.NewV4().String()
  req := buildTestRequest(attemptUUID)
  // 1. T04.Originate -> assertion: returns CallUUID == attemptUUID.
  // 2. SELECT * FROM originate_audit WHERE attempt_uuid=? -> assertion: 1 row, outcome=SUCCESS.
  // 3. SELECT * FROM call_log WHERE uuid=? -> assertion: 1 row, attempt_uuid matches.
  // 4. EXISTS t:{tid}:in_flight:{attemptUUID} HASH -> assertion: true.
  // 5. SELECT * FROM recording_log WHERE uuid=? -> assertion: if recording mode != OFF, 1 row.
}
```

### 7.4 Forbidden patterns

- T04 must never call `uuid.NewV4()` itself. Doing so means the caller forgot to supply `req.AttemptUUID`; the gRPC validator and the Go SDK both reject `req.AttemptUUID == ""` with `ErrMissingAttemptUUID` (a `codes.InvalidArgument` gRPC status).
- A single `attempt_uuid` must never be reused across two `T01.Originate` calls (per RESEARCH §12 cite [9] — FS "duplicate UUID CRIT"). Replays return the prior result without a second T01 hop.

---

## 8. Public API — Go SDK + gRPC

### 8.1 Go package layout

```
dialer/internal/originate/
├── originate.go            # Originate(ctx, req) entry point + driver loop (~180 LOC)
├── request.go              # OriginateRequest, OriginateResult, OriginateError types (~120 LOC)
├── audit.go                # insertAuditRow, finalizeAuditRow, AuditRowPatch merge (~120 LOC)
├── chanvars.go             # buildChannelVars: 16 keys from req + scratch (~100 LOC)
├── cid_picker.go           # PickCallerID 4-tier waterfall (~80 LOC)
├── janitor.go              # SweepOrphans for E06 (~70 LOC)
├── consent.go              # vendored 12-state matrix (Phase 1; C02 import in Phase 1.5) (~60 LOC)
├── metrics.go              # 9 Prom collectors + helpers (~80 LOC)
├── gates/
│   ├── gateway_cap.go      # ~90 LOC
│   ├── drop_cap.go         # ~70 LOC (Phase 1 stub returns ALLOW)
│   ├── tcpa.go             # ~70 LOC (calls C01.Check)
│   ├── dnc.go              # ~120 LOC (incl. bypass-token redemption)
│   └── consent.go          # ~70 LOC
└── *_test.go               # ~700 LOC of unit + integration tests
```

Plus `shared/proto/dialer.proto` extension (~80 LOC) and the
`api/src/originate/` Node client (~120 LOC) that wraps the gRPC stub for
A04 to call into.

### 8.2 Public types

```go
// dialer/internal/originate/request.go
package originate

type OriginateRequest struct {
    // Idempotency + correlation (REQUIRED)
    AttemptUUID  string  // UUIDv4 lowercase; caller-supplied; rejected if empty
    TenantID     int64
    LeadID       int64
    CampaignID   string  // VARCHAR(32) per F02 §4.6
    ListID       int64
    AgentID      int64   // 0 for PREDICTIVE pre-answer

    // Destination
    DestNumber   string  // E.164

    // Mode + caller-ID overrides
    Mode             OriginateMode  // PROGRESSIVE | PREDICTIVE | MANUAL | PREVIEW
    CallerIDOverride string         // per-call tier-1 override; "" = use waterfall
    CallerIDName     string

    // Carrier hint (optional; T02 picks if 0)
    CarrierID    int64

    // FS affinity (Phase 1: leave empty; X03 wires later)
    FSHost       string

    // Compliance bypass (DNC only; F05 RBAC + D05 token enforce)
    BypassToken  string  // empty = no bypass

    // Caller context (audit / forensic)
    RequestID    string  // trace correlation id
    IPAddress    string  // gRPC peer / forwarded-for
    ActorUserID  int64   // who is making this request (for MANUAL/A04)
}

type OriginateResult struct {
    AttemptUUID string  // echo of req.AttemptUUID
    CallUUID    string  // == AttemptUUID by policy; T01 returned identifier
    AuditRowID  int64   // for cross-table joins
    Outcome     OriginateOutcome
    GateApplied string  // "" if all ALLOW; name of the blocking gate otherwise
}

// All errors implement this interface so callers can release the hopper
// claim with the right retry hint and D04 status.
type OriginateError interface {
    error
    Gate() string                // "gateway_cap" / "drop_cap" / "tcpa" / "dnc" / "consent" / "carrier"
    SubReason() string
    RetryAfter() time.Duration
    AttemptUUID() string
    D04Status() string           // "GATEWAY_LIMIT_TRY_LATER" | "TCPA" | "DNC" | "CONSENT_NOT_OBTAINED" | "CARRIER_FAIL"
}
```

### 8.3 Public function signatures

```go
// dialer/internal/originate/originate.go
package originate

// Originate runs the 5-gate compliance pipeline, INSERTs the audit row,
// and (on ALLOW) calls T01.Client.Originate with the assembled channel
// vars.
//
// Returns (*OriginateResult, nil) on full pipeline pass; the audit row is
// finalized as SUCCESS or transport-fail in a single UPDATE before return.
//
// Returns (nil, OriginateError) for any gate block or transport fail; the
// audit row carries the gate decision + error_message.
//
// Returns (nil, ErrInProgress) if a row already exists with outcome=OTHER
// for the supplied attempt_uuid (another worker is racing the same intent).
//
// Returns (*OriginateResult, nil) with .AuditRowID populated and no T01
// hop made if a row already exists with outcome != OTHER (idempotent
// replay).
func (s *Service) Originate(ctx context.Context, req OriginateRequest) (*OriginateResult, error)

// SweepOrphans is called by E06 every 60s. Returns the count of rows
// updated to JOB_ORPHANED.
func (s *Service) SweepOrphans(ctx context.Context) (int, error)

// New constructs the Service with all gate dependencies wired.
type Opts struct {
    DB           *sql.DB
    Valkey       valkey.Client
    T01Client    *esl.Client
    TCPAChecker  *tcpa.Checker
    DNCClient    *dnc.Client
    ConsentFunc  func(consent.CheckOpts) consent.ConsentDecision  // Phase 1: vendored; Phase 1.5: C02 import
    Now          func() time.Time  // overridable for tests
    Metrics      *Metrics
    Logger       *slog.Logger
}
func New(opts Opts) *Service
```

### 8.4 gRPC service (`shared/proto/dialer.proto` addition)

```protobuf
service T04OriginateService {
  // Originate runs the 5-gate compliance pipeline and (on pass) calls
  // T01.Originate. Idempotent on attempt_uuid.
  //
  // Errors map to gRPC status codes:
  //   FAILED_PRECONDITION  — any gate BLOCK (details carry Gate + SubReason)
  //   UNAVAILABLE          — carrier/transport fail (T01 ErrCircuitOpen, ErrFSDead)
  //   RESOURCE_EXHAUSTED   — gateway_cap or rate_limited
  //   ALREADY_EXISTS       — idempotent replay (response carries prior result)
  //   INVALID_ARGUMENT     — missing attempt_uuid / malformed E.164 / etc.
  //   INTERNAL             — audit insert failure or other unexpected
  rpc Originate(OriginateRequest) returns (OriginateResponse);
}

message OriginateRequest {
  string attempt_uuid = 1;     // required
  int64  tenant_id   = 2;
  int64  lead_id     = 3;
  string campaign_id = 4;
  int64  list_id     = 5;
  int64  agent_id    = 6;
  string dest_number = 7;      // E.164
  OriginateMode mode = 8;
  string caller_id_override = 9;
  string caller_id_name     = 10;
  int64  carrier_id  = 11;
  string fs_host     = 12;
  string bypass_token = 13;
  string request_id  = 14;
  string ip_address  = 15;
  int64  actor_user_id = 16;
}

message OriginateResponse {
  string attempt_uuid = 1;
  string call_uuid    = 2;
  int64  audit_row_id = 3;
  OriginateOutcome outcome = 4;
  string gate_applied = 5;
}

enum OriginateMode { PROGRESSIVE = 0; PREDICTIVE = 1; MANUAL = 2; PREVIEW = 3; }
enum OriginateOutcome { SUCCESS = 0; TCPA_BLOCKED = 1; DNC_BLOCKED = 2;
                       CONSENT_BLOCKED = 3; GATEWAY_LIMIT = 4;
                       RATE_LIMITED = 5; GATEWAY_FAIL = 6; TIMEOUT = 7;
                       JOB_ORPHANED = 8; OTHER = 9; }
```

The Node client lives at `api/src/originate/client.ts` and is consumed by A04's `POST /api/agent/manual-dial` handler.

---

## 9. Channel-var schema (16 keys assembled by T04, executed by T01)

T04 builds a `map[string]string` and hands it to T01 via `OriginateRequest.ChannelVars`. T01 sorts and serializes deterministically (snapshot tests). The 16 keys are grouped into 5 logical sets (mirrors RESEARCH §4):

### 9.1 Group A — Caller-ID (from `PickCallerID` waterfall)

| Var | Source |
|---|---|
| `origination_caller_id_number` | `scratch.CallerID` (E.164 with leading `+`) |
| `origination_caller_id_name` | `scratch.CallerIDName` |
| `effective_caller_id_number` | same as above |
| `sip_from_user` | same — survives Twilio/Bandwidth From-rewrites per T02 RESEARCH §2 |

### 9.2 Group B — Originate behavior

| Var | Source |
|---|---|
| `ignore_early_media` | always `true` |
| `originate_timeout` | `campaigns.dial_timeout_sec` (default 22) |
| `call_timeout` | mirror of `originate_timeout` |
| `hangup_after_bridge` | `true` for `dial_target=CONFERENCE`; `false` for `PARK` |
| `execute_on_answer` | T01 builds from `OnAnswerAction`; T04 sets it indirectly by setting `OnAnswer` on the T01 request |

### 9.3 Group C — Correlation IDs (round-trip on every CHANNEL_* event)

| Var | Source |
|---|---|
| `vici2_tenant_id` | `req.TenantID` |
| `vici2_lead_id` | `req.LeadID` |
| `vici2_campaign_id` | `req.CampaignID` |
| `vici2_agent_id` | `req.AgentID` |
| `vici2_attempt_uuid` | `req.AttemptUUID` |
| `vici2_carrier_id` | `scratch.ResolvedCarrierID` |
| `vici2_gateway_id` | `scratch.ResolvedGatewayID` |
| `origination_uuid` | `req.AttemptUUID` (one-UUID rule) |

### 9.4 Group D — Recording / consent (for R01)

| Var | Source |
|---|---|
| `vici2_consent_required` | `"true"` if `scratch.ConsentDecision == ConsentPrompt`, else `"false"` |
| `vici2_consent_state` | `leads.state` (called-party) |
| `vici2_recording_mode` | mapped from `campaigns.recording_mode`: `NEVER`→`OFF`, `ONDEMAND`/`ALL`→`ON`, `ALLFORCE`→`FORCED`; if `ConsentDecision == ConsentSkipRecording` → `OFF` regardless |
| `RECORD_STEREO` | always `"true"` (R01 recommends stereo for downstream transcription) |

### 9.5 Group E — SIP X-headers (carrier-specific + Phase 4 branded-calling)

| Var | Source |
|---|---|
| `sip_h_X-Vici2-Lead` | `req.LeadID` |
| `sip_h_X-Vici2-Campaign` | `req.CampaignID` |
| `sip_h_X-Vici2-Attempt` | `req.AttemptUUID` |
| `sip_h_X-Brand` | Phase 4 N05 from `did_numbers.brand_token` (Phase 1: not set) |

### 9.6 Determinism

`buildChannelVars` returns the map; T01 sorts by key for serialization. Snapshot tests in `chanvars_test.go` lock the exact wire form for each of the 24 (mode × outcome) base scenarios.

---

## 10. Error taxonomy

All errors implement the `OriginateError` interface (§8.2). One concrete type per gate; transport errors wrap T01's error set.

| Concrete type | `Gate()` | `SubReason()` examples | `RetryAfter()` | `D04Status()` | Maps to gRPC code |
|---|---|---|---|---|---|
| `ErrGatewayLimit` | `gateway_cap` | `gw:<id>:full` | `0s` | `GATEWAY_LIMIT_TRY_LATER` | `RESOURCE_EXHAUSTED` |
| `ErrDropCap` | `drop_cap` | `campaign:<id>:1.7%>=1.5%` | `5m` (configurable) | unchanged | `RESOURCE_EXHAUSTED` |
| `ErrTCPABlocked` | `tcpa` | `before_window` / `after_window` / `state_sunday_blackout` / `state_holiday_blackout` / `no_timezone` / `state_autodialer_window` | `result.NextOpen - now` or `24h` | `TCPA` | `FAILED_PRECONDITION` |
| `ErrDNCHit` | `dnc` | comma-joined source list e.g. `federal,internal` | `0s` (never re-queue) | `DNC` | `FAILED_PRECONDITION` |
| `ErrConsentBlocked` | `consent` | `consent_block:<state>` (rare — only when `ConsentDecision == ConsentBlock`) | `0s` | `CONSENT_NOT_OBTAINED` | `FAILED_PRECONDITION` |
| `ErrCarrierFail` | `carrier` | wraps T01's `ErrCircuitOpen` / `ErrFSDead` / `ErrJobOrphaned` / `ErrRateLimited` | `60s` (circuit) / `300s` (orphaned) / `5s` (rate-limited) | `CARRIER_FAIL` | `UNAVAILABLE` |
| `ErrInProgress` | n/a | n/a | `1s` | unchanged | `ALREADY_EXISTS` |
| `ErrMissingAttemptUUID` | n/a | n/a | `0s` | unchanged | `INVALID_ARGUMENT` |

The error type also carries `AttemptUUID()` so callers can correlate to the audit row + log entry without re-deriving it from context.

---

## 11. Caller-ID waterfall (`PickCallerID`)

Lives at `dialer/internal/originate/cid_picker.go`. Returns `(number, name string, source OriginateCidSource, err error)`.

```go
func PickCallerID(ctx context.Context, deps Deps, req OriginateRequest,
                  lead Lead, list List, campaign Campaign) (string, string, OriginateCidSource, error) {

    // Tier 1: per-call override
    if req.CallerIDOverride != "" {
        return req.CallerIDOverride, req.CallerIDName, OriginateCidSourcePerCall, nil
    }

    // Tier 2: per-list override (F02 AMENDMENT T04.3+T04.4)
    if list.CallerIDOverride != nil && *list.CallerIDOverride != "" {
        return *list.CallerIDOverride, deref(list.CallerIDName, ""),
               OriginateCidSourcePerList, nil
    }

    // Tier 3: local-presence (X05, Phase 3.5)
    if deps.X05 != nil && campaign.LocalPresenceEnabled {
        if did, err := deps.X05.PickLocalDID(ctx, lead.PhoneE164); err == nil && did != nil {
            return did.Number, did.CallerIDName, OriginateCidSourceLocalPresence, nil
        }
        // miss: emit metric + fall through
        deps.Metrics.LocalPresenceMiss.WithLabelValues(npanxx(lead.PhoneE164)).Inc()
    }

    // Tier 4: campaign default
    if campaign.CallerIDOverride != nil && *campaign.CallerIDOverride != "" {
        return *campaign.CallerIDOverride, "", OriginateCidSourceCampaignDefault, nil
    }

    // Last resort: error — every campaign should have a default CID set in admin
    return "", "", "", fmt.Errorf("no caller-id available for campaign %s", campaign.ID)
}
```

Phase 1: tiers 1 + 2 + 4 wired; tier 3 returns nil (X05 not yet implemented). Caller-ID picker runs **before** the gates because some gates (e.g., a future per-CID gateway-cap) might depend on the picked CID.

---

## 12. Metrics

All Prometheus collectors in `dialer/internal/originate/metrics.go`. Names prefixed `vici2_t04_` for namespace clarity.

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `vici2_t04_originate_total` | Counter | `tenant`, `campaign`, `mode`, `outcome` | Master KPI. |
| `vici2_t04_compliance_blocked_total` | Counter | `gate`, `sub_reason` | Per-gate BLOCK breakdown. |
| `vici2_t04_gate_duration_seconds` | Histogram | `gate` | Buckets `0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 1`. Validates per-gate budgets in §3. |
| `vici2_t04_audit_insert_latency_seconds` | Histogram | (none) | INSERT + UPDATE latency. |
| `vici2_t04_idempotent_replays_total` | Counter | `mode` | Replay rate; high values may indicate caller retry storms. |
| `vici2_t04_dnc_bypass_token_redeemed_total` | Counter | `actor_user_id` (low-card) | Bypass-token usage; security-review surface. |
| `vici2_t04_inflight` | Gauge | (none) | `OTHER`-state audit rows currently. |
| `vici2_t04_local_presence_miss_total` | Counter | `npa_nxx` | X05 pool exhaustion forensic. |
| `vici2_t04_carrier_fail_total` | Counter | `fs_host`, `reason` | T01 transport-fail breakdown. |

### 12.1 Alerts (O01 owns the rule files; T04 only specifies the trigger semantics)

| Alert | Severity | Trigger | Rationale |
|---|---|---|---|
| `T04TCPABlockSpike` | **PAGE (SEV1)** | `increase(vici2_t04_compliance_blocked_total{gate="tcpa"}[5m]) > 100` | E01 hopper-filler is broken or campaign config drifted — many calls past hopper hit the originate TCPA gate. |
| `T04CarrierFailRateHigh` | warning | `rate(vici2_t04_carrier_fail_total[5m]) > 5` | Carrier all-down or T01 breaker tripped. |
| `T04InflightStuck` | warning | `vici2_t04_inflight > 5× avg_over_time(...) for 2m` | E04 picker stuck, carrier all-down, or janitor not reaping. |
| `T04AuditInsertLatencyHigh` | warning | `histogram_quantile(0.99, vici2_t04_audit_insert_latency_seconds_bucket) > 0.05` | MySQL slow path; F02 buffer pool pressure. |
| `T04BypassTokenAbuse` | warning | `increase(vici2_t04_dnc_bypass_token_redeemed_total[1h]) > 10` | Possible abuse — `dnc:bypass` should be rare. |

---

## 13. Test plan

### 13.1 Unit tests (per gate)

Each gate lives in its own file with table-driven tests covering:

| Gate | Test scenarios |
|---|---|
| `gateway_cap` | `active < max`, `active == max`, `active > max`, `gateway_id == 0` (no resolution yet), Valkey error → propagate. |
| `drop_cap` | Phase-1 stub always ALLOW; Phase-2 fixtures `rate < limit`, `rate == limit`, `rate > limit`, Valkey error. |
| `tcpa` | Stubbed `tcpa.Checker` returning each of `ALLOW`/`SKIP_UNTIL`/`BLOCK_INVALID` with each `Reason` value; ensure all 8 reasons in C01's controlled vocab round-trip. |
| `dnc` | `dnc.IsDnc` returns (false, nil), (true, ["federal"]), (true, ["federal","internal"]), error; bypass-token redemption path with valid token + invalid token + expired token. |
| `consent` | All 12 PROMPT states + 5 ALLOW states + interstate stricter-state-wins; `recording_mode=NEVER` → SKIP_RECORDING; `recording_mode=ALLFORCE` + 2-party state → PROMPT (force never overrides law). |

### 13.2 Integration tests (driver + audit row + T01 mock)

In `dialer/internal/originate/integration_test.go` against a real MySQL container (matching F02's CI service) + an in-memory T01 mock implementing the `OriginateClient` interface:

- **24 base scenarios** = 4 modes × 6 outcomes
  (`SUCCESS`, `GATEWAY_LIMIT`, `RATE_LIMITED`, `TCPA_BLOCKED`, `DNC_BLOCKED`, `CARRIER_FAIL`).
- **One-UUID round-trip** (§7.3): assert `attempt_uuid == call_uuid == FS Job-UUID == origination_uuid` across one full happy-path call.
- **Idempotent replay**: call `Originate` twice with the same `attempt_uuid`; assert second call returns the cached result without invoking T01 mock (mock recorder counts 1 call total).
- **Concurrent replay** (`ErrInProgress`): two goroutines call `Originate` with the same `attempt_uuid` simultaneously; assert exactly one wins (1 audit row), the loser returns `ErrInProgress`.
- **Janitor reaping**: insert a fake `outcome='OTHER' AND originated_at < NOW() - 10 MINUTE` row; call `SweepOrphans`; assert row UPDATEd to `JOB_ORPHANED`.
- **Audit-row column matrix**: for each blocking gate, assert the row has the gate's columns populated and all downstream gate columns NULL.
- **Channel-var snapshot**: for the PROGRESSIVE + MANUAL + PREDICTIVE happy paths, assert `buildChannelVars` output matches the locked-in snapshot fixture in `testdata/chanvars/`.
- **Bypass-token redemption**: valid token redeems exactly once; replay returns `tokenAlreadyRedeemed` error from D05; audit row has `bypass_token` set.

### 13.3 Consent-state fixtures

`testdata/consent_states.yaml` — one fixture per state + interstate combinations (12 PROMPT states × 1 ALLOW state for caller + matrix of called-party-only / interstate stricter-state-wins).

### 13.4 Coverage target

≥ 80% on `dialer/internal/originate/` (driver + gates + chanvars + cid_picker + audit). 90% on gate files because each one is small and the path matrix is finite.

### 13.5 Load/perf smoke

Optional `BenchmarkOriginate` against the MySQL container, 1000 iterations. Goal: p99 ≤ 8 ms end-to-end on the happy path (incl. INSERT + UPDATE + 5 gate calls + T01 mock). If p99 > 10 ms, IMPLEMENT phase must profile and fix before HANDOFF.

---

## 14. Files to be created/changed

### 14.1 New files

| File | Owner | LoC budget |
|---|---|---|
| `dialer/internal/originate/originate.go` | T04 | ~180 |
| `dialer/internal/originate/request.go` | T04 | ~120 |
| `dialer/internal/originate/audit.go` | T04 | ~120 |
| `dialer/internal/originate/chanvars.go` | T04 | ~100 |
| `dialer/internal/originate/cid_picker.go` | T04 | ~80 |
| `dialer/internal/originate/janitor.go` | T04 | ~70 |
| `dialer/internal/originate/consent.go` | T04 (vendored Phase 1) | ~60 |
| `dialer/internal/originate/metrics.go` | T04 | ~80 |
| `dialer/internal/originate/gates/gateway_cap.go` | T04 | ~90 |
| `dialer/internal/originate/gates/drop_cap.go` | T04 | ~70 |
| `dialer/internal/originate/gates/tcpa.go` | T04 | ~70 |
| `dialer/internal/originate/gates/dnc.go` | T04 | ~120 |
| `dialer/internal/originate/gates/consent.go` | T04 | ~70 |
| `dialer/internal/originate/*_test.go` | T04 | ~700 |
| `dialer/internal/originate/testdata/chanvars/*.json` | T04 | ~200 |
| `dialer/internal/originate/testdata/consent_states.yaml` | T04 | ~80 |
| `shared/proto/dialer.proto` (T04 section) | T04 | ~80 |
| `api/src/originate/client.ts` (Node gRPC client wrapper) | T04 | ~120 |
| `api/src/originate/types.ts` (TS mirror of the Go types) | T04 | ~80 |

**Total IMPLEMENT budget: ~2 500 LoC** (excludes generated protobuf code; ~1 800 production + ~700 tests).

### 14.2 Changed files

| File | Change |
|---|---|
| `dialer/cmd/dialer/main.go` | Wire `originate.Service` into the gRPC server registration; add `T04OriginateService` registration. ~20 LoC. |
| `dialer/cmd/dialer/main.go` (E06 wiring) | Schedule `originate.SweepOrphans` every 60 s. ~15 LoC. |
| `shared/proto/dialer.proto` | Add `T04OriginateService` and messages (see §8.4). |
| `api/src/routes/agent/manual-dial.ts` (A04 integration point — A04 owns the file, T04 only adds the gRPC client wiring) | Replace stub T04 call with real `originate.Client.Originate` call. Documented in HANDOFF, not edited by T04. |

### 14.3 No F02 changes needed

F02 AMENDMENTS A1 / T04.1–T04.4 already landed in
`api/prisma/schema.prisma` (verified at PLAN-time: `OriginateAudit` model
present line 1440; `lists.callerIdOverride` + `callerIdName` present line
416–417; 4 new D04 system statuses called out in header comment lines
70–74; migration files present under
`api/prisma/migrations/20260506204550_f02_amendments/` and
`20260506204600_partition_amendment_tables/`). T04 IMPLEMENT does not file
further F02 amendments.

---

## 15. Acceptance criteria — VERIFY checklist

A T04 IMPLEMENT submission is acceptable iff:

- [ ] `dialer/internal/originate/originate.go` exports `Service.Originate` with the signature in §8.3.
- [ ] Every BLOCK path INSERTs exactly one `originate_audit` row with the gate-specific columns populated per §5.
- [ ] Every ALLOW path INSERTs one row with `outcome='OTHER'` then UPDATEs once to a terminal value; the UPDATE WHERE clause includes `outcome='OTHER' AND outcome_at IS NULL`.
- [ ] Idempotent replay returns the prior result without invoking T01; one-UUID rule integration test passes (§7.3).
- [ ] Gate order is exactly `gateway_cap → drop_cap → tcpa → dnc → consent`; first BLOCK short-circuits; downstream gate columns are NULL on early BLOCK.
- [ ] All 9 metrics in §12 are registered with the global Prometheus registry; `make metrics-lint` passes (cardinality budget).
- [ ] `shared/proto/dialer.proto` registers `T04OriginateService.Originate` with the message shapes in §8.4; `make proto-gen` produces no diff.
- [ ] Channel-var snapshot tests pass for all 24 base scenarios.
- [ ] Unit-test coverage ≥ 80% on `dialer/internal/originate/`.
- [ ] Integration tests in `dialer/internal/originate/integration_test.go` pass against the F02 MySQL container.
- [ ] No `_ = uuid.NewV4()` or similar UUID generation inside `dialer/internal/originate/` (CI grep enforces).
- [ ] No raw `"agent_"` conference-name string literals (T03 RFC-002 lint passes).
- [ ] `dialer/internal/originate/` does **not** import `dialer/cmd/eslbridge/...` and is imported only by `dialer/cmd/dialer/main.go` + E02/E04 packages (CI grep enforces; T01 must never import this package, asserted by grep).
- [ ] Bypass-token redemption emits a `audit_log` row via D05's redemption hook; the row is queryable by `bypass_token` in `originate_audit`.
- [ ] BenchmarkOriginate p99 ≤ 10 ms on the happy path.
- [ ] HANDOFF.md documents: the C02 vendored matrix swap process; the X05 local-presence pickup point; the X03 FS-affinity pickup point; the E03 drop-cap pickup point; the A04 gRPC client wiring instructions; the bypass-token RBAC requirement (`dnc:bypass` permission).

---

## 16. Dependencies — exact modules T04 imports

### 16.1 Compile-time imports (Go)

```
dialer/internal/originate/
  imports
    dialer/internal/esl                (T01)           — *esl.Client, OriginateRequest, OnAnswerConference, OnAnswerPark, ErrCircuitOpen, ErrFSDead, ErrJobOrphaned, ErrRateLimited
    dialer/internal/conference         (T03)           — ConferenceName, ConferenceFQN
    dialer/internal/compliance/tcpa    (C01)           — Checker, Check, CheckRequest, CheckResult, EnforcementPoint, Outcome*
    dialer/internal/compliance/dnc     (D05)           — Client, IsDnc, RedeemBypassToken
    dialer/internal/gateway            (T02)           — Reader (max_concurrent + active gauge); gateway+carrier resolver
    dialer/internal/db                 (F02)           — *sql.DB, partition-aware INSERT/UPDATE helpers, prepared-statement registry
    shared/proto/dialer (generated)                    — protobuf types for the gRPC service
    github.com/prometheus/client_golang/prometheus     — metrics
    google.golang.org/grpc                             — gRPC server / status codes
    log/slog                                           — structured logging
```

### 16.2 Runtime dependencies

| Module | What T04 uses from it |
|---|---|
| **T01** | `*esl.Client.Originate(ctx, *esl.OriginateRequest) (callUUID, error)` for the transport call. T04 sets `req.PreSuppliedUUID = req.AttemptUUID` and `req.PreSuppliedJobID = req.AttemptUUID` so the one-UUID rule holds. |
| **T02** | `gateway.Reader.PickGateway(tenantID, carrierID, leadE164) (*Gateway, error)` + `gateway.Reader.ActiveCount(gatewayID) int` — feeds the gateway-cap gate. |
| **T03** | `conference.ConferenceFQN(tenantID, agentID, "default")` — only allowed conference-name producer per RFC-002. |
| **C01** | `tcpa.Check(ctx, req)` — feeds the TCPA gate. |
| **D05** | `dnc.IsDnc(ctx, tenantID, phone, state, campaignID)` + `dnc.RedeemBypassToken(ctx, token, tenantID)` — feeds the DNC gate. |
| **F02** | `originate_audit`, `lists`, `campaigns`, `leads`, `carriers`, `gateways` tables; partitioned INSERT helper for the audit table. |
| **F04** | Valkey keys: `t:{tid}:gw:{gid}:active`, `t:{tid}:campaign:{cid}:drop_rate_30d` (Phase 2), `t:{tid}:dnc:bypass:<token>`. |
| **F05** | `requireAuth + requirePermission('originate:execute')` on the gRPC handler; `requirePermission('dnc:bypass')` for `bypass_token` redemption (gRPC interceptor reads token → resolves actor → checks permission). |
| **E06** | `originate.SweepOrphans` called every 60 s. |
| **R01** | Reads `vici2_consent_required`, `vici2_consent_state`, `vici2_recording_mode`, `RECORD_STEREO` channel vars (T04 sets, R01 dialplan acts). |
| **C03** | Consumes `originate_audit` via the same retention/grant model as `audit_log`; T04 only writes via the DAL. |

### 16.3 Modules that depend on T04 (downstream consumers)

| Module | What it calls |
|---|---|
| **E02** (pacing) | `originate.Service.Originate(ctx, req)` for every pacing tick. |
| **E04** (picker) | Same — PROGRESSIVE path (post-pick) and PREDICTIVE path (pre-park). |
| **A04** (manual dial) | gRPC `T04OriginateService.Originate` via Node client. |
| **A07** (transfer) | `originate.Service.Originate` with `Mode=MANUAL` for the closer leg. |
| **N01** (external REST, Phase 4) | gRPC `T04OriginateService.Originate` with `Idempotency-Key` HTTP header → `attempt_uuid`. |
| **E06** (janitor) | `originate.Service.SweepOrphans`. |

---

## 17. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **C02 module landing changes the consent enum shape** | medium | low (T04 vendors the function, not the enum) | Vendor `ConsentDecision` enum with stable values now (§3.5); when C02 lands, T04 imports C02's enum which is contract-tested to match. CI test in C02 PLAN should assert enum-value equality. |
| **T01 returns success at bgapi level but FS never bridges (silent fail)** | low | high | T01 PLAN §13.4 covers the BACKGROUND_JOB 60s timeout; T04 maps timeout to `JOB_ORPHANED` and E06 reaps. Additionally, every audit row has a deterministic `originated_at + 5min` cutoff so the maximum forensic gap is 5 minutes. |
| **Idempotency replay race when two callers race the same `attempt_uuid`** | low | medium (would double-dial) | `SELECT ... FOR UPDATE` inside a tx around the INSERT; concurrent integration test in §13.2 guards this. UNIQUE constraint is the backstop — duplicate INSERT fails with `1062 duplicate key`, which T04 catches and resolves via re-SELECT. |
| **Audit row INSERT fails (MySQL down) on the BLOCK path** | low | high (no TCPA evidence) | INSERT failure on a BLOCK returns `ErrAuditInsertFailed` (an internal error, not `OriginateError`); the originate is NOT dispatched to T01; caller MUST treat as a hard failure and not retry to a different ID. Metric `vici2_t04_audit_insert_failed_total` pages on any non-zero rate. |
| **`origination_uuid` collision between two `bgapi originate` calls** | extremely low (UUIDv4 birthday math) | high (FS "Duplicate UUID CRIT" — RESEARCH cite [9]) | One UUID per intent; never reuse across `T01.Originate` calls; replay returns prior result without re-dispatch. UUIDv4 collision probability at 100 CPS for a year is ~3×10⁻¹⁵. |
| **Gateway capacity gauge drift between Valkey counter and FS truth** | medium | medium (false BLOCK or over-dial) | T02 PLAN §10 specifies 60-second reconciler that corrects drift > 2. T04 trusts the Valkey value. Underdial preferred to overdial — the regulatory cost of overdial is unbounded. |
| **`bypass_token` leaked / replayed** | low | high (illegal call) | D05 mints token as `SET NX EX 60` single-use; redemption is atomic. F05 RBAC limits `dnc:bypass` to `superadmin` role. C03 audit_log captures every mint + redemption. Alert on `vici2_t04_dnc_bypass_token_redeemed_total` rate. |
| **C01 returns SKIP_UNTIL with `NextOpen` in the past (DST edge)** | low | medium (lead never re-queues) | Defensive clamp: if `NextOpen <= now()`, T04 returns `RetryAfter=24h` and emits `vici2_t04_tcpa_clock_skew_total{from="c01"}` warning. C01 RESEARCH §3 DST regression suite catches the case but defense-in-depth here. |
| **PREDICTIVE answer-time abandon race (no agent available, customer answered)** | high (steady-state pacing behavior) | low | E04 owns the abandon path (calls `T01.UUIDPlayAndHangup` + writes `drop_log`); T04 already finalized `outcome=SUCCESS` because the originate itself succeeded transport-wise. The abandon is a separate fact, counted in E05. Documented in HANDOFF. |
| **Vendored consent matrix goes stale (state changes 2-party law)** | medium (legal change cadence is months-to-years) | medium | Matrix is in code, reviewed via PR + legal sign-off (annotated CSV per state with statute citation). On state-law change: CSV edit + regenerate + ship in next release. Phase 1.5: C02 owns this entirely. |

---

## 18. Open items for orchestrator

None blocking — every RESEARCH §11 open question is decided in §1.3.

The following are **noted for cross-module followups**:

- **D04 system statuses** (`TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`) need to be in D04's hangup-cause → status mapping logic. T04 just emits the `D04Status()` hint via the typed error; D04 owns translation into `dispositions.status_code`. Tracked in D04 PLAN dependency list.
- **C02 vendored-matrix swap** is a one-PR migration when C02 PLAN lands. Estimated < 1 day; HANDOFF will include the diff.
- **X05 local-presence picker** integration point is named (`deps.X05.PickLocalDID`); when X05 PLAN lands the wiring is mechanical.
- **N05 branded-calling** integration point is named (`sip_h_X-Brand` channel var) and Phase-4-deferred; no T04 PLAN change needed when N05 lands.
- **E03 drop-rate gauge** stub returns ALLOW; when E03 PLAN lands the gate body becomes the Valkey GET. Documented in `gates/drop_cap.go` TODO.

---

## STOP — PLAN frozen, awaiting orchestrator approval.

When unblocked, IMPLEMENT must:

1. Ship the 14 production files in `dialer/internal/originate/` per §14.1.
2. Ship the `shared/proto/dialer.proto` `T04OriginateService` registration.
3. Ship the Node gRPC client wrapper in `api/src/originate/`.
4. Wire `originate.Service` into `dialer/cmd/dialer/main.go` (gRPC server registration + `SweepOrphans` 60-s ticker).
5. Pass every test in §13 against a real MySQL container + Valkey + T01 mock.
6. Meet the 9 metric registrations in §12.
7. Pass the one-UUID round-trip integration test in §7.3.
8. Update HANDOFF with the four follow-up pickup points listed in §18.
