# C02 — Recording Consent Handler — RESEARCH

**Module:** C02 (Pre-bridge recording-consent gate; ensures C02-decided consent posture is in place BEFORE R01.StartRecording fires)
**Phase:** 1 (compliance hard floor — SPEC §4.1)
**Working scope:** US-only Phase 1 (50 states + DC + PR/VI/GU/MP/AS). Canada deferred to Phase 4. EU/UK GDPR deferred (not on roadmap).
**Status:** RESEARCH (input to C02 PLAN)

> **Stakes.** Vici2 markets to outbound call centers. Outbound call centers
> get sued for missing recording consent in two-party-consent ("all-party")
> states. A single missed disclosure on a recorded call to a California
> resident is statutorily $5,000 per call (Cal. Penal Code §637.2) and
> commonly aggregated as a class action across an entire campaign. The
> compliance-floor invariant in SPEC §4.1 — "Recording consent prompt (in
> 2-party-consent states) before agent bridge" — is therefore not a
> nice-to-have feature; the rest of the system **must not be able to start
> a recording without C02 having already decided this is allowed**. This
> document gathers the legal and technical grounding C02 PLAN needs to
> build that gate correctly.

---

## 1. TL;DR (PLAN-relevant findings)

1. **The federal floor is one-party consent (18 USC §2511(2)(d))** — 1986 ECPA amendment. A party to the call may record. Federal preempts NOTHING with respect to states being stricter; ECPA explicitly leaves room for state law (§2511(2)(d) "*unless such communication is intercepted for the purpose of committing any criminal or tortious act in violation of the Constitution or laws of the United States or of any State*").
2. **Twelve states are "all-party consent" for telephone recording in 2026.** Per the 50-state survey synthesis (RESEARCH §3): **CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA**. Some of these have meaningful carve-outs — CT distinguishes criminal (1-party) vs civil (all-party); OR distinguishes electronic (1-party) vs in-person (2-party); PA has a 2024 telemarketer/robocall recipient carve-out (§5704(19)). The list **counts thirteen if Connecticut is included for civil safety**, which we do.
3. **Stricter-state-wins is the 2026 consensus for interstate calls.** The leading authority is *Kearney v. Salomon Smith Barney, Inc.*, 39 Cal.4th 95 (2006), where the California Supreme Court applied California's all-party rule to interstate calls because California has a materially greater interest in protecting California residents' privacy. Courts and compliance practitioners have generalized this: when ANY end of an interstate call is in a 2-party state, **assume the 2-party rule applies**. C02's algorithm (§9 below) implements this.
4. **Beep-tone "consent" has narrow legal cover and we do NOT default to it.** 47 CFR §64.501(c) recognizes a continuous beep tone as one of three permissible disclosures — BUT the rule only binds **telephone common carriers**, not enterprise call centers. Most state two-party statutes do not name beep tone as sufficient consent; some courts have rejected beep-only as defective notice in commercial/recording contexts (e.g., *Kearney* held disclosure must be a clear notification, not merely a tone). C02 ships beep as a Phase-1-available mode but **default is `PROMPT_MESSAGE`** (pre-recorded notification + implied consent via continued participation).
5. **"This call may be recorded" + continued participation = implied consent in most 2-party states**, by judicial gloss. PA explicitly recognizes implied consent through continued participation after a clear and audible disclosure; CA, IL, MA accept it as well when the disclosure is clear and audible (failure mode: "buried" or unclear disclosure). C02's `PROMPT_MESSAGE` mode is built around this established pattern.
6. **Active consent (DTMF "press 1" or verbal "yes") is not legally required anywhere we surveyed**, but is risk-reducing in high-stakes domains (debt collection, healthcare, mortgage). C02 exposes `REQUIRE_ACTIVE` as an opt-in mode for tenants who want maximum defensibility.
7. **B2B exception is narrow but real for PA.** 18 Pa.C.S. §5704(15) permits one-party consent recording of "telephone marketing or telephone customer service" calls when made for training, quality control, or monitoring — **but the recording must be destroyed within one year** unless other law requires retention. CA's analogue (§632(c)) is narrower — the "confidential communication" requirement does most of the work, but business calls where price/credit-card info is shared are still confidential per *Taylor v. ConverseNow* (N.D. Cal. 2025). C02 supports a `LeadIsBusiness` flag with a per-state lookup; we are conservative and only honor B2B for PA in Phase 1.
8. **Consent durability is per-call.** Most state statutes (and federal) treat each communication as its own event; consent given on one call does NOT extend to future calls. C02 logs a row per call (consent_log table — F02 amendment §6 below).
9. **"Litigator suppression" risk drives the design.** Q1-2025 alone saw **507 new TCPA class actions, +112% YoY** (Faegre Drinker analysis cited via leadgen-economy 2025). 31–41% of TCPA filings come from serial plaintiffs ("professional plaintiffs"). Missing a CIPA disclosure on a recorded call to a California resident is statutorily $5,000/call (Cal. Penal Code §637.2). **A single missed-consent campaign can be a >$1M class action.** C02 is the gate that prevents this.
10. **Vicidial has no built-in consent gate.** Vicidial's `recording_filename` is set in the campaign config and the dialplan starts `record_session` unconditionally on bridge. There is no per-state state-aware consent prompt; operators add hand-rolled XML and hope. Vici2's C02 is the affirmative answer: a typed gate that decides BEFORE recording starts and writes an audit row per decision.
11. **The 2024 PA HB 1278 amendment (§5704(19))** carved out incoming telemarketer/robocall recordings — a recipient may record without all-party consent for the purpose of TCPA / consumer-protection enforcement. This is an inbound-only carve-out and does NOT apply to outbound dialer calls; flagged for completeness.
12. **PCI overlay is C02-adjacent but separate.** R01 PLAN §4.3 already specifies that C02 plays the consent prompt; PCI DTMF-suppression sidecars (PCI Pal / Eckoh / Semafone / Aeriandi) layer on top of C02 in Phase 2. C02 does NOT enter PCI scope.
13. **Codegen pattern follows C01 (TCPA window gate) exactly:** single source-of-truth CSV `db/seeds/consent_rules.csv`, generates `dialer/internal/compliance/consent/rules_gen.go` and (Phase 2) `api/src/compliance/consent/rules.gen.ts`. PR-and-deploy is the change-control process.

---

## 2. The legal floor (federal)

### 2.1 Federal Wiretap Act / ECPA — 18 USC §2511

- Codified at **18 USC §2511(2)(d)** (1986 ECPA amendment to the original 1968 Wiretap Act). One-party consent: any party to a wire, oral, or electronic communication may consent to its interception, **unless** the interception is "for the purpose of committing any criminal or tortious act."
- **Federal preempts NOTHING for states being stricter.** 18 USC §2511(2)(d) operates as a floor; states are free to require all-party consent (and twelve do).
- Federal jurisdiction does kick in on truly interstate calls in two ways:
  - Federal Wiretap Act civil action (§2520) is available, but recovery is bounded ($10K/incident or $100/day, whichever greater) — typically smaller than state CIPA recovery for the same conduct.
  - FCC §64.501 (next subsection) binds common carriers, not enterprise users.

### 2.2 47 CFR §64.501 — FCC common-carrier recording rule

- **Scope: telephone common carriers** recording conversations with members of the public. NOT directly binding on enterprise call centers. Cited frequently in compliance literature as the source of the "beep tone is OK" idea, but the binding scope is narrow.
- Three permitted disclosures (any one suffices, per the rule):
  - (a) prior verbal or written consent of all parties,
  - (b) verbal notification recorded at the start of the call by the recording party, OR
  - (c) automatic tone warning device producing a distinct signal repeated at regular intervals during the call.
- Tone characteristics frozen by 1947–1948 FCC Orders ("Use of Recording Devices in Connection With Telephone Service," Docket 6787): **continuous beep, repeated at regular intervals (commonly cited as ~1400 Hz, ≥0.5s, every 15s).**
- **Why we do not default to beep:** §64.501 binds carriers and is rarely cited as a safe harbor in state-court CIPA / WESCA / IL Eavesdropping cases. State statutes set their own bar. In CA, beep-only with no verbal disclosure has been challenged as inadequate notification (the *Kearney* line treats the disclosure as needing to be "clear" — a tone is not clearly equivalent to "this call is being recorded" in many courts' view). C02 ships beep as an explicit opt-in (`PROMPT_BEEP`) for tenants whose use case is bound by §64.501 (e.g., a telco subsidiary), but never as default.

### 2.3 TCPA cross-reference

- TCPA (47 USC §227) governs auto-dialed calls and pre-recorded message calls; it is largely **orthogonal** to recording-consent law. C02 cares about TCPA only insofar as the same plaintiffs who sue under TCPA also pile on CIPA/IL Eavesdropping claims. C01 (TCPA quiet-hours gate) is the dedicated TCPA module; C02's compliance metric (§13) feeds the same Grafana panel.

---

## 3. The 12-state matrix (all-party consent for telephone recording)

This is the canonical list C02 codes against. Sources are listed in §15. The matrix is keyed on the called-party's state (resolved by D03 from `lead.state`, `lead.zip` → `lead.state`, or `lead.phone` NPA-NXX → `state`). Each row is an entry in `db/seeds/consent_rules.csv`.

| State | Statute | Default mode (C02) | Beep accepted? | B2B exempt? | Notes |
|---|---|---|---|---|---|
| **CA** | Cal. Penal Code §§632, 632.7 (CIPA) | `PROMPT_MESSAGE` | NO | LIMITED — confidential-communication test (*Taylor v. ConverseNow* 2025 confirms business calls are confidential when PII/credit-card shared) | $5K/call statutory damages (§637.2). Section 632.7 specifically covers cellular/cordless and removed malicious-intent requirement. |
| **CT** | Conn. Gen. Stat. §52-570d (civil) / §53a-187 (criminal) | `PROMPT_MESSAGE` | NO | No clear exemption | Civil: all-party. Criminal: 1-party. Treat as 2-party for civil safety. §52-570d explicitly allows verbal notice + continued participation (implied consent). |
| **DE** | 11 Del.C. §1335; 11 Del.C. §2402 | `PROMPT_MESSAGE` | NO | No B2B carve-out | DE has both a 1-party criminal statute (§2402) and an all-party civil/wiretap statute (§1335). Stricter-state-wins → all-party. |
| **FL** | Fla. Stat. §934.03 | `PROMPT_MESSAGE` | NO | No B2B carve-out | All-party. Felony violation if willful. *Shevin v. Sunbeam* (Fla. 1977) established broad scope. |
| **IL** | 720 ILCS 5/14-2 (post-2014 amendment) | `PROMPT_MESSAGE` | NO | No B2B carve-out for outbound; §14-3 has narrow public-officials carve-outs | All-party for "private conversation" (intent-to-be-private test, post-2014). Customers calling a business **not** automatically consenting. |
| **MD** | Md. Cts. & Jud. Proc. Code §10-402 | `PROMPT_MESSAGE` | NO | No B2B carve-out | All-party. Felony violation. |
| **MA** | Mass. Gen. Laws ch. 272 §99 | `PROMPT_MESSAGE` | NO | No B2B carve-out | "Secretly" recording is the operative test — clear pre-call disclosure removes secrecy → cures the violation. Up to $10K fine + 5y prison for criminal violation. |
| **MI** | Mich. Comp. Laws §750.539c | `PROMPT_MESSAGE` | NO | LIMITED | All-party for "private discourse" under Sullivan v. Gray (1984) Mich. App. line; some authority reads §750.539c as 1-party for a participant. **Conservative posture: treat as all-party.** |
| **MT** | Mont. Code Ann. §45-8-213 | `PROMPT_MESSAGE` | NO | No clear exemption | All-party with narrow carve-outs (emergency, public officials). |
| **NH** | N.H. Rev. Stat. §570-A:2 | `PROMPT_MESSAGE` | NO | No B2B carve-out | All-party. Among strictest in the country. |
| **OR** | Or. Rev. Stat. §165.540 | `PROMPT_MESSAGE` | NO | No B2B carve-out | 1-party for **electronic/telephone**, all-party for **in-person**. Telephone-only call centers technically fall under 1-party — BUT industry practice treats OR as 2-party for safety because of OR's Unlawful Trade Practices Act overlay. **C02 codes as `PROMPT_MESSAGE` (treats as 2-party) by default; tenant override possible.** |
| **PA** | 18 Pa.C.S. §§5703–5704 (WESCA) | `PROMPT_MESSAGE` | NO | YES — §5704(15) for telephone marketing/customer-service training/QC monitoring | Felony violation. §5704(15) B2B exemption requires destruction within 1 year. §5704(19) (HB 1278, 2024) carves out incoming telemarketer recordings (recipient-side, not us). |
| **WA** | Wash. Rev. Code §9.73.030 | `PROMPT_MESSAGE` | NO | No B2B carve-out | All-party. §9.73.030(3) explicitly recognizes "announcement-then-continued-call" implied consent — continuous prompt + audible at start of call satisfies. |

**One-party consent states (38 + DC + territories):** AL, AK, AZ, AR, CO, GA, HI, ID, IN, IA, KS, KY, LA, ME, MN, MS, MO, NE, NV, NJ, NM, NY, NC, ND, OH, OK, RI, SC, SD, TN, TX, UT, VT, VA, WV, WI, WY, AK, DC, AS, GU, MP, PR, VI. C02 returns `Decision: ALLOW` for these (no prompt needed; record-by-default).

---

## 4. The five consent decision modes (C02 vocabulary)

C02 normalizes legal posture into five exhaustive decision modes. Every C02 invocation returns exactly one of these.

| Mode | Meaning | When chosen | Dialplan effect |
|---|---|---|---|
| `ALLOW` | One-party state; no prompt; recording proceeds. | Federal-only call OR called-party state ∈ 1-party states. | F03 dialplan sets `consent_record_enabled=true`; R01 `record_session` fires unconditionally on `CHANNEL_ANSWER`. |
| `PROMPT_BEEP` | Continuous warning beep tone for the recording duration. | §64.501-bound common carrier OR tenant explicitly opted in. | F03 dialplan calls `consent_beep_continuous` extension which configures `beep_event` for duration of `record_session`. Recording starts immediately. |
| `PROMPT_MESSAGE` | Pre-recorded "this call may be recorded" plays once at start; continued participation = implied consent. | DEFAULT for all 2-party states (conservative-default). | F03 dialplan calls `consent_message_only` extension: `playback ${consent_msg}`, then `set consent_record_enabled=true`, then bridge to agent / start recording. |
| `REQUIRE_ACTIVE` | Pre-recorded message + DTMF `1`-to-consent / `2`-to-decline (or verbal yes/no via ASR — Phase 4). | Tenant-elective for high-risk verticals (debt collection, healthcare, mortgage). | F03 dialplan calls `consent_message_active` extension: `playback ${consent_msg}` then `play_and_get_digits` 1-or-2; on `1` enable recording, on `2` either continue without recording OR hangup per `campaign.opt_out_action`. |
| `SKIP` | Do not record at all. | Either consent flow failed (e.g., `prompted_declined` in `REQUIRE_ACTIVE` mode) AND `campaign.opt_out_action=continue_no_record`, OR campaign `recording_mode=NEVER`, OR tenant policy forbids recording in this state outright. | F03 dialplan does NOT execute `record_session`; `consent_record_enabled=false`. R01.StartRecording would return `ErrConsentMissing` if invoked. |

**Mode strictness ordering (used by stricter-state-wins intersection):**
```
SKIP > REQUIRE_ACTIVE > PROMPT_MESSAGE > PROMPT_BEEP > ALLOW
```
Two states involved in an interstate call → C02 picks the maximum (most strict) of the two.

---

## 5. Per-tenant consent policy

Two layers of override above the legal floor:

### 5.1 Tenant minimum mode (`tenants.consent_minimum_mode`)

Each tenant sets a floor — the minimum strictness applied to ALL their campaigns regardless of called-party state. Defaults to `PROMPT_MESSAGE` (conservative).

| Tenant minimum | Effect |
|---|---|
| `ALLOW` | "Trust the legal default"; permits 1-party-state ALLOW pass-through. **Phase-1 default for legacy migrations only**; production default is `PROMPT_MESSAGE`. |
| `PROMPT_BEEP` | Tenant always wants at least continuous beep. |
| `PROMPT_MESSAGE` | **Default.** Even in 1-party states, play the message — for brand consistency / customer trust signaling. |
| `REQUIRE_ACTIVE` | Tenant always wants explicit yes. (e.g., a debt collector in collections mode) |
| `SKIP` | Tenant has globally disabled recording. (e.g., HIPAA-adjacent tenant with no recording authorization) |

C02's check: `final_mode = max(legal_minimum_for_state, tenant_minimum)`.

### 5.2 Per-campaign override (`campaigns.consent_policy_override`)

NULL by default. When non-NULL, the campaign overrides the tenant minimum (subject to legal-minimum floor — campaign cannot loosen below state law).

| Campaign override | Use case |
|---|---|
| NULL | Use tenant minimum. |
| `PROMPT_BEEP` | Telco-tenant subsidiary running a §64.501-scope campaign. |
| `REQUIRE_ACTIVE` | Mortgage / collections campaign requires yes-confirmation. |
| `SKIP` | Internal staff training campaign; no recording desired. |

**Admin-only:** Setting `consent_policy_override` requires `role=admin`+ in M02 (campaign editor) per A07/M02 PLAN handoff. The audit log captures who flipped it.

### 5.3 Resolution algorithm

```
final_mode = stricter_of(
    state_legal_minimum_for(lead.state),       -- legal floor per matrix
    state_legal_minimum_for(caller.state),     -- stricter-state-wins
    tenant.consent_minimum_mode,               -- tenant floor
    campaign.consent_policy_override            -- campaign override
)
-- where stricter_of() applies the ordering: SKIP > REQUIRE_ACTIVE > PROMPT_MESSAGE > PROMPT_BEEP > ALLOW
```

If `lead.state IS NULL` (state unknown — D03 returned no signal) → C02 PAGES O01 (`vici2_compliance_consent_state_missing_total` counter; alert wired) AND defaults to **`PROMPT_MESSAGE`** (conservative-default; same posture as 2-party states).

---

## 6. The B2B exception (narrow)

Only PA explicitly grants a B2B / telephone-marketing carve-out at the state-statute level (§5704(15)). CA narrows recording exposure for non-confidential business communications, but post-*Taylor v. ConverseNow* (N.D. Cal. 2025) any business call where the consumer shares PII or financial info is presumed confidential — so we cannot rely on B2B-exemption posture for CA.

C02 exposes a `LeadIsBusiness` flag on `CheckConsent`. The flag flows from D01 (`leads.is_business BOOLEAN`) populated at import time (CSV import marks B2B leads). Per-state behavior:

| State | `LeadIsBusiness=true` effect |
|---|---|
| **PA** | Mode downgrades from `PROMPT_MESSAGE` to `ALLOW` per §5704(15), provided `campaign.recording_purpose ∈ ('training','quality_control','monitoring')` AND retention is ≤ 1 year (C04 retention enforces). |
| All other 2-party states | NO change — B2B flag ignored. (CA could be added in Phase 4 with stricter conditions; not Phase 1.) |
| 1-party states | NO change — already `ALLOW`. |

The `recording_purpose` field is a new column on `campaigns` (F02 amendment §6.4 below).

---

## 7. The interstate / stricter-state-wins doctrine

### 7.1 *Kearney v. Salomon Smith Barney, Inc.*, 39 Cal.4th 95 (2006) — leading case

Salomon Smith Barney brokers in Atlanta, GA recorded calls with California clients. GA is 1-party; CA is all-party. The Cal. Supreme Court applied California's all-party rule prospectively because California has "a materially greater interest than Georgia in protecting the privacy of California residents." Recording without disclosure thus creates CIPA exposure even when the recording party is in a 1-party state.

**Holding generalized:** for any interstate call, if any end of the call is in a 2-party state, the 2-party rule controls.

### 7.2 Compliance-practitioner consensus (2026)

Industry compliance guides (NextPhone 2026, Recording Law 2026, Versadial, Justia 50-state survey) uniformly recommend "stricter-state-wins" as the default operating posture for any interstate call center. The downside risk (a single CIPA class action at $5K/call × 50,000 calls = $250M exposure) so dwarfs the upside (slightly fewer prompts) that no responsible operator runs the other way.

### 7.3 What "caller state" means in our system

`CallerState` is the agent's state — typically the call-center physical location, but Phase 4 remote-agent rollouts may vary per agent. Phase 1 single-tenant assumes a single `tenant.default_caller_state` (new column on `tenants` — F02 amendment §6.1). Phase 4 reads `users.state` (or remote-agent's connection metadata).

If `CallerState IS NULL`, treat as the most-permissive (1-party) for interstate-comparison purposes — the state-wins logic still picks the lead's state's rule. Page O01 with `vici2_compliance_consent_caller_state_missing_total`.

---

## 8. Beep tone, examined

### 8.1 What §64.501 says exactly

(c) "Where such use shall be accompanied by an automatic tone warning device, which will automatically produce a distinct signal that is repeated at regular intervals during the course of the telephone conversation when the recording device is in use."

(1) Tone characteristics frozen to 1947–1948 FCC Orders. Industry implementations: **1400 Hz, 0.5s duration, every 15s.** This is the de-facto frequency cited in Asterisk / FreeSWITCH `displace_session beep.wav loop` recipes.

### 8.2 Why beep alone is insufficient in most state-court analyses

- §64.501 binds common carriers; its safe-harbor effect on enterprise users is murky.
- The state two-party statutes (CIPA, WESCA, IL Eavesdropping, etc.) speak in terms of "consent" or "notification," and most courts read those terms as requiring something more semantic than a tone — typically a verbal disclosure ("this call may be recorded") OR explicit prior consent.
- Tone-only recording has been litigated under CIPA — the disclosure-must-be-clear gloss in *Kearney* and progeny disfavors tone-only.
- WA and PA case law explicitly contemplate verbal pre-call disclosure; tone alone has not been held sufficient there either.

### 8.3 Beep is still useful

- Phase 2 PCI sidecars frequently use beep DURING masked recording windows (so customer knows recording continues even when their card-number entry is being suppressed).
- §64.501-bound tenants (telco subsidiaries) can opt into beep mode; we ship the capability.
- Beep is cheap to implement (FreeSWITCH `displace_session beep.wav loop`, no playback latency) and is allowed-in-addition-to message in many tenant policies.

### 8.4 C02 default

`PROMPT_MESSAGE` (verbal disclosure + implied consent via continued participation). Beep is opt-in.

---

## 9. The CheckConsent function (Go API)

### 9.1 Inputs/outputs

```go
package consent

type Mode int  // ALLOW < PROMPT_BEEP < PROMPT_MESSAGE < REQUIRE_ACTIVE < SKIP

type CheckRequest struct {
    LeadID, TenantID, CampaignID int64
    LeadState, CallerState       string  // 2-letter codes; "" if unknown
    LeadIsBusiness               bool
    CampaignRecordingPolicy      string  // "ALWAYS" | "NEVER" | "ON_DEMAND" | "AUTO"
    CampaignRecordingPurpose     string  // "general" | "training" | "quality_control" | "monitoring"
    TenantMinimumMode            Mode
    CampaignOverrideMode         *Mode   // nil = no override
}

type CheckResult struct {
    Decision     Mode    // final mode
    Mechanism    string  // human-readable: "PROMPT_MESSAGE/lead-state-CA"
    StateApplied string  // 2-letter code that drove the decision (after stricter-state-wins)
    Reason       string  // audit-log explainer: "stricter-state-wins: lead.state=CA (PROMPT_MESSAGE) > caller.state=TX (ALLOW)"
}

func CheckConsent(ctx context.Context, req CheckRequest) CheckResult
```

### 9.2 Hot-path performance budget

- Pure data lookup (no DB, no Redis); reads in-memory `stateRules map[string]ConsentRule` (codegen).
- Target: p99 < 200µs (T04 RESEARCH §3.5 already budgets 200µs for this gate).
- Zero allocations on hot path: pre-allocated CheckResult zero-value, string interning for state codes.

### 9.3 Algorithm (psuedo)

```
1. legal_lead_mode    = consentRules[req.LeadState].MinimumMode  // PROMPT_MESSAGE if unknown
2. legal_caller_mode  = consentRules[req.CallerState].MinimumMode if req.CallerState != "" else ALLOW
3. legal_mode         = stricter_of(legal_lead_mode, legal_caller_mode)
4. if req.LeadIsBusiness && B2BExempt(req.LeadState) && req.CampaignRecordingPurpose ∈ {training,quality_control,monitoring}:
       legal_mode = ALLOW   // PA §5704(15) carve-out
5. tenant_mode        = req.TenantMinimumMode
6. legal_or_tenant    = stricter_of(legal_mode, tenant_mode)
7. if req.CampaignOverrideMode != nil:
       campaign_mode = *req.CampaignOverrideMode
       final         = stricter_of(legal_or_tenant, campaign_mode)
                       // campaign cannot loosen below legal floor
   else:
       final = legal_or_tenant
8. if req.CampaignRecordingPolicy == "NEVER":
       final = SKIP
9. return {Decision: final, StateApplied: state-that-drove-it, Reason: chain-of-reasoning}
```

---

## 10. Three integration points with the rest of vici2

### 10.1 T04 (originate) — call-time invocation

T04 RESEARCH §3.5 already budgets `CheckConsent` as the 5th of 5 pre-originate gates. T04 calls `CheckConsent` and writes two channel vars on the originate channel-var blob:
- `vici2_consent_required = "true"|"false"` (true if mode != ALLOW)
- `vici2_consent_mode = "ALLOW"|"PROMPT_BEEP"|"PROMPT_MESSAGE"|"REQUIRE_ACTIVE"|"SKIP"`
- `vici2_consent_state = "CA"` (state that drove the decision — for audit + dialplan logging)

T04 also writes the C02 audit row (consent_log) inline for the BLOCK path (mode == SKIP); ALLOW/PROMPT modes write the row at dialplan-extension-completion time via a separate hook (§10.2).

### 10.2 F03 dialplan extensions — runtime execution

On `CHANNEL_ANSWER` of the customer leg, `customer_into_agent_conf` calls one of three new extensions based on `vici2_consent_mode`:

```xml
<extension name="recording_consent_check">
  <condition field="${vici2_consent_mode}" expression="^ALLOW$">
    <action application="set" data="consent_record_enabled=true"/>
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
  </condition>
</extension>

<extension name="consent_message_only">
  <condition>
    <action application="answer"/>
    <action application="playback" data="${consent_msg_audio}"/>
    <action application="set" data="consent_record_enabled=true"/>
    <action application="set" data="vici2_consent_status=prompted_assumed"/>
  </condition>
</extension>

<extension name="consent_message_active">
  <condition>
    <action application="answer"/>
    <action application="play_and_get_digits"
            data="1 1 3 5000 # ${consent_msg_audio} silence_stream://250 vici2_consent_dtmf [12]"/>
    <action application="set" data="consent_record_enabled=${expr(${vici2_consent_dtmf} == 1)}"/>
    <action application="set" data="vici2_consent_status=${cond(${vici2_consent_dtmf} == 1 ? prompted_accepted : prompted_declined)}"/>
    <!-- if declined and campaign.opt_out_action=hangup: hangup; else continue without record -->
  </condition>
</extension>

<extension name="consent_beep_continuous">
  <condition>
    <action application="answer"/>
    <action application="set" data="record_beep_pre=tone_stream://%(500,0,1400)"/>
    <!-- beep continues during record_session via record_beep_pre + displace_session in Phase 2 -->
    <action application="set" data="consent_record_enabled=true"/>
    <action application="set" data="vici2_consent_status=beep_only"/>
  </condition>
</extension>
```

### 10.3 R01 (recording) — gating

R01 PLAN §11.1 already gates `record_session` on `${consent_record_enabled}`. C02 is the writer of that var. R01.StartRecording (Go API) ALSO calls back to verify `consent_status` is set on the channel BEFORE issuing `bgapi uuid_record start` — defense in depth.

R01 PLAN §10.1 documents the channel-var contract:
| `vici2_consent_status` | R01 behavior |
|---|---|
| `not_required` (ALLOW) | record_session runs immediately |
| `prompted_accepted` (REQUIRE_ACTIVE) | record_session runs |
| `prompted_assumed` (PROMPT_MESSAGE) | record_session runs |
| `beep_only` (PROMPT_BEEP) | record_session runs with beep |
| `prompted_declined` (REQUIRE_ACTIVE no) | record_session does NOT run; if `opt_out_action=hangup`, hangup |

C02 PLAN aligns with this contract exactly.

---

## 11. F02 amendment request — `consent_log` table + columns

C02 needs an audit row per call (per-call durability per §13). Proposed F02 amendment (filed by C02 PLAN; merged into F02-AMENDMENTS branch).

### 11.1 NEW table `consent_log`

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
    consent_status  ENUM('not_required','prompted_accepted','prompted_declined','prompted_assumed','beep_only','skipped') NULL,
    reason          VARCHAR(255) NULL,
    recorded_at     DATETIME(6) NOT NULL,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id, recorded_at),
    INDEX idx_tlc (tenant_id, lead_id, recorded_at),
    INDEX idx_call (call_uuid),
    INDEX idx_t_state (tenant_id, state_applied, recorded_at)
)
ENGINE=InnoDB
PARTITION BY RANGE COLUMNS(recorded_at) (
    PARTITION p_2026_05 VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06 VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07 VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08 VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max    VALUES LESS THAN (MAXVALUE)
);

-- INSERT-only grant (parallel to audit_log per F02 PLAN §4.5):
REVOKE UPDATE, DELETE ON `vici2`.`consent_log` FROM `vici2`@`%`;
```

Retention: 7 years (matches `audit_log`, `recording_log`, `drop_log` per F02 PLAN §6). C04 retention worker rotates partitions.

### 11.2 NEW column on `tenants`

```sql
ALTER TABLE tenants
    ADD COLUMN consent_minimum_mode ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP')
        NOT NULL DEFAULT 'PROMPT_MESSAGE',
    ADD COLUMN default_caller_state CHAR(2) NULL;
```

### 11.3 NEW columns on `campaigns`

```sql
ALTER TABLE campaigns
    ADD COLUMN consent_policy_override ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP') NULL,
    ADD COLUMN recording_purpose ENUM('general','training','quality_control','monitoring') NOT NULL DEFAULT 'general',
    ADD COLUMN opt_out_action ENUM('continue_no_record','hangup') NOT NULL DEFAULT 'continue_no_record',
    ADD COLUMN consent_msg_audio VARCHAR(255) NULL;
```

### 11.4 Seed `consent_rules.csv`

`db/seeds/consent_rules.csv` is the source-of-truth committed to repo. Single CSV; `tcpa-rulesgen`-style codegen produces Go and TS mirrors.

```
state,minimum_mode,beep_accepted,b2b_exempt,citation
CA,PROMPT_MESSAGE,false,false,Cal. Penal Code §§632 632.7
CT,PROMPT_MESSAGE,false,false,Conn. Gen. Stat. §52-570d
DE,PROMPT_MESSAGE,false,false,11 Del.C. §1335
FL,PROMPT_MESSAGE,false,false,Fla. Stat. §934.03
IL,PROMPT_MESSAGE,false,false,720 ILCS 5/14-2
MD,PROMPT_MESSAGE,false,false,Md. Cts. & Jud. Proc. §10-402
MA,PROMPT_MESSAGE,false,false,Mass. Gen. Laws ch.272 §99
MI,PROMPT_MESSAGE,false,false,Mich. Comp. Laws §750.539c
MT,PROMPT_MESSAGE,false,false,Mont. Code Ann. §45-8-213
NH,PROMPT_MESSAGE,false,false,N.H. Rev. Stat. §570-A:2
OR,PROMPT_MESSAGE,false,false,Or. Rev. Stat. §165.540 (conservative posture)
PA,PROMPT_MESSAGE,false,true,18 Pa.C.S. §§5703-5704 (B2B §5704(15))
WA,PROMPT_MESSAGE,false,false,Wash. Rev. Code §9.73.030
# ALL OTHER STATES (1-party): default ALLOW
```

The matrix codegen reads this and produces `dialer/internal/compliance/consent/rules_gen.go` containing:
```go
var stateRules = map[string]ConsentRule{
    "CA": {State: "CA", MinimumMode: PROMPT_MESSAGE, BeepAccepted: false, B2BExempt: false, Citation: "Cal. Penal Code §§632 632.7"},
    // ...
}
// returns ALLOW for any state not in the map (1-party default)
```

---

## 12. Per-call durability (no future-call inheritance)

Most state statutes treat each communication as its own event. Consent on call N does NOT extend to call N+1. C02 enforces this:
- One `consent_log` row per call (keyed on `call_uuid`).
- C02 does NOT cache consent decisions across calls.
- Lead-level "this person consented to recording" flags would be DANGEROUS (false sense of security; statutes don't recognize them) and are explicitly OUT OF SCOPE.

The single exception we surveyed: WA's announcement-then-continued-call doctrine arguably extends within a single call. C02 treats this as still per-call (the announcement happens at start of each call).

---

## 13. Litigator-suppression context (drives the rigor)

| Source | Stat |
|---|---|
| leadgen-economy 2025 (cite §15) | **Q1-2025: 507 new TCPA class actions, +112% YoY.** |
| TCPALitigatorList.com | **31–41% of TCPA filings come from serial plaintiffs.** Suppression lists exist; gaps: new numbers, lag time, identity changes. |
| Cal. Penal Code §637.2 | **$5,000 per call** statutory damages under CIPA (private right of action). |
| *Taylor v. ConverseNow* (N.D. Cal. 2025) | Court denied MTD; AI customer-service call recording without disclosure = CIPA §632 violation even for a pizza order, when PII shared. **Class certification possible.** |
| 47 USC §227 (TCPA) civil penalty | $500/call (negligent), $1500/call (willful). Often layered with CIPA in CA cases. |

A 50,000-call campaign with missing CIPA disclosure = **$250M statutory exposure in CA alone**. That dwarfs the cost of building C02 correctly. The system invariant — **"R01 cannot start without C02 having ALLOWED it"** — is the only thing that prevents this.

---

## 14. Comparison vs Vicidial

| Aspect | Vicidial | Vici2 (C02) |
|---|---|---|
| Per-state consent matrix | Hand-rolled per operator; many use 1-party-everywhere | Codified `db/seeds/consent_rules.csv`; codegen mirrored to Go + TS; PR-and-deploy change-control |
| Consent prompt | Manual XML in dialplan; operator-built | Three pre-built F03 extensions: `consent_message_only`, `consent_message_active`, `consent_beep_continuous` |
| Consent decision audit | None built-in (operator must add to `vicidial_log`) | `consent_log` table; INSERT-only grant; partitioned monthly; 7-year retention |
| Stricter-state-wins | Not implemented | Built-in via `stricter_of()` algorithm |
| Per-tenant minimum | Not implemented (single-tenant) | `tenants.consent_minimum_mode` |
| Per-campaign override | Not implemented | `campaigns.consent_policy_override` |
| B2B exception | Not implemented | `leads.is_business` + per-state `B2BExempt` flag |
| Recording start gate | Always on, dialplan unconditional | Gated on `consent_record_enabled` channel-var; R01.StartRecording double-checks |

---

## 15. Citations (16)

1. **18 USC §2511 (ECPA / Federal Wiretap Act)** — `https://www.law.cornell.edu/uscode/text/18/2511`. One-party consent floor.
2. **47 CFR §64.501** — `https://www.govinfo.gov/content/pkg/CFR-2010-title47-vol3/pdf/CFR-2010-title47-vol3-sec64-501.pdf`. FCC carrier recording rule (verbal consent / verbal notification / beep tone).
3. **FCC Consumer Guide — Recording Telephone Conversations** (2019) — `https://www.fcc.gov/consumers/guides/recording-telephone-conversations`. "FCC has no rules regarding recording of telephone conversations by individuals; some state laws prohibit." Confirms §64.501 enterprise-scope ambiguity.
4. **FindLaw — Recording Telephone Conversations** (2024) — `https://corporate.findlaw.com/litigation-disputes/recording-telephone-conversations.html`. Three permitted disclosures under §64.501 per FCC; tone characteristics frozen to 1947–1948 Orders.
5. **Recording Law — Two-Party Consent States 2026 Guide** — `https://www.recordinglaw.com/party-two-party-consent-states/`. Industry-canonical 12-state list 2026.
6. **NextPhone — Call Recording Laws by State 2026** — `https://www.getnextphone.com/blog/call-recording-laws-by-state`. State-by-state 2026 compliance guide.
7. **Justia — Recording Phone Calls and Conversations: 50-State Survey** — `https://www.justia.com/50-state-surveys/recording-phone-calls-and-conversations/`. Statutory cites per state.
8. **WorldPopulationReview — Two-Party Consent States 2026** — `https://worldpopulationreview.com/state-rankings/two-party-consent-states`. Cross-validation of 12-state list.
9. **Kearney v. Salomon Smith Barney, Inc., 39 Cal.4th 95 (2006)** — `https://caselaw.findlaw.com/court/ca-supreme-court/1099204.html`. Stricter-state-wins for interstate calls.
10. **Cal. Penal Code §§ 632, 632.7 (CIPA), 637.2 ($5K/call private action)** — `https://privacyrights.org/resources-tools/law-overviews/california-invasion-privacy-act-cipa`. Privacy Rights Clearinghouse CIPA primer.
11. **Taylor v. ConverseNow Technologies, Inc.** (N.D. Cal. 2025; MTD denied) — `https://www.wsgrdataadvisor.com/2025/09/u-s-federal-court-allows-cipa-class-action-against-ai-customer-service-provider-to-proceed/` — Wilson Sonsini analysis.
12. **18 Pa.C.S. §§ 5703–5704 (Pennsylvania WESCA, Wiretapping and Electronic Surveillance Control Act)** — `https://law.justia.com/codes/pennsylvania/title-18/chapter-57/section-5704/`. §5704(4) all-party rule; §5704(15) telephone-marketing/QC B2B exception (1-yr retention requirement); §5704(19) HB 1278 (Feb 2024) telemarketer-recipient inbound carve-out.
13. **Pennsylvania Phone Call Recording Laws 2026** — `https://www.recordinglaw.com/party-two-party-consent-states/pennsylvania-recording-laws/phone-calls`. Implied-consent-via-continued-participation analysis; 2024 amendment.
14. **720 ILCS 5/14-2 (Illinois Eavesdropping Act, post-2014 SB 1342)** — `https://www.ilga.gov/documents/legislation/ilcs/documents/072000050K14-2.htm`. All-party consent for "private conversation"; intent-to-be-private test post-People v. Clark.
15. **Mass. Gen. Laws ch. 272 §99 + Glik v. Cunniffe, 655 F.3d 78 (1st Cir. 2011)** — `https://malegislature.gov/Laws/GeneralLaws/PartIV/TitleI/Chapter272/Section99`. "Secretly" recording is the operative test; clear pre-call disclosure cures.
16. **leadgen-economy — TCPA Litigation Statistics 2025** — `https://www.leadgen-economy.com/blog/tcpa-litigation-statistics/`. Q1-2025: 507 new TCPA class actions, +112% YoY; 31–41% serial-plaintiff filings; $1500/call willful penalty.
17. **TCPALitigatorList.com — Litigator suppression operations** — `https://tcpalitigatorlist.com/`. Industry suppression lists; documented gaps (new numbers, lag, identity).
18. **Wash. Rev. Code §9.73.030(3) — announcement-then-continued-call doctrine** — `https://app.leg.wa.gov/rcw/default.aspx?cite=9.73.030`. Implied-consent contemporaneous announcement.

---

## 16. Open questions (resolved in PLAN)

| # | Question | RESEARCH preferred answer | PLAN resolves |
|---|---|---|---|
| 1 | Default mode in 2-party states | `PROMPT_MESSAGE` (verbal disclosure + implied consent) | YES |
| 2 | Default mode in 1-party states | `ALLOW` (no prompt) | YES |
| 3 | When `lead.state IS NULL` | Default to `PROMPT_MESSAGE` (conservative); page O01 | YES |
| 4 | Beep-only mode default-on? | NO. Opt-in only. | YES |
| 5 | B2B carve-out scope | PA only Phase 1; CA Phase 4 | YES |
| 6 | Per-call vs per-lead durability | Per-call (`consent_log` keyed on `call_uuid`) | YES |
| 7 | Caller-state for stricter-state-wins | `tenants.default_caller_state` Phase 1; `users.state` Phase 4 | YES |
| 8 | Decline behavior | Per-campaign: `opt_out_action ∈ {continue_no_record, hangup}` | YES |
| 9 | Audio file management | Per-campaign `consent_msg_audio` column; default `freeswitch/sounds/consent/vici2_consent_msg_default.wav` | YES |
| 10 | Codegen pattern | Mirror C01: single CSV → Go + TS | YES |
| 11 | Test fixtures | CA→FL, TX→NY, CA→TX, B2B FL→PA | YES |
| 12 | CT civil-vs-criminal | Treat as 2-party (civil-side safety) | YES |
| 13 | OR electronic-vs-in-person | Treat as 2-party for telephone (industry posture) | YES |

---

## 17. Hand-off contracts (forward-looking; PLAN finalizes)

| Module | C02 input | C02 output |
|---|---|---|
| **C01** | None (C01 enforces TCPA quiet-hours; orthogonal) | None |
| **D03** | `lead.state` resolved by D03 (or null) | `CheckRequest.LeadState` |
| **D01** | `leads.state`, `leads.is_business` columns | Read by C02 |
| **F02** | F02-AMENDMENTS branch lands `consent_log` table + tenant/campaign columns | C02 owns the seed CSV `db/seeds/consent_rules.csv` |
| **F03** | F03 amendment lands `consent_message_only`, `consent_message_active`, `consent_beep_continuous`, `recording_consent_check` extensions + `freeswitch/sounds/consent/` directory | C02 owns the audio file management |
| **R01** | R01 PLAN §10.1 contract: `vici2_consent_status` channel-var → R01 behavior table | C02 sets the channel-var |
| **T04** | T04 RESEARCH §3.5: `CheckConsent` is 5th of 5 pre-originate gates | T04 passes channel-vars via originate string |
| **C03** | `consent_log` immutability via INSERT-only grant | C03 audits grants |
| **C04** | `consent_log` partition rotation (7-year retention) | C04 owns rotation |
| **O01** | C02 metrics: `vici2_compliance_consent_check_total{decision}`, `vici2_compliance_consent_skipped_total`, `vici2_compliance_consent_state_missing_total` (PAGE), `vici2_compliance_consent_state_mismatch_total` | O01 wires alerts |
| **M02** | Campaign editor surfaces `consent_policy_override`, `recording_purpose`, `opt_out_action`, `consent_msg_audio` | C02 PLAN documents the UX |
| **M05** | Tenant editor surfaces `consent_minimum_mode`, `default_caller_state` (admin-only) | C02 PLAN documents the UX |

---

## 18. RESEARCH-phase risk register

| Risk | Mitigation in PLAN |
|---|---|
| State law changes mid-quarter | Codegen makes mechanical: edit CSV, PR, deploy. Quarterly compliance review. |
| Court reinterprets "consent" stricter than `PROMPT_MESSAGE` | Tenant can opt up to `REQUIRE_ACTIVE`. Consent-fatigue UX risk acknowledged. |
| `lead.state` unresolved (D03 returns nothing) | Default to `PROMPT_MESSAGE` + page. Still legally defensible. |
| Beep alone insufficient in some courts | Default = `PROMPT_MESSAGE`, NOT beep. Beep is opt-in. |
| Consent fatigue (every call has prompt) | Acceptable cost; enterprise users tolerate it. UX research → make message ≤ 2s. |
| Interstate caller-state unknown | Page; default to lead-state-only logic. |
| B2B exception over-broad | PA only in Phase 1; documented narrow carve-outs only. |
| `consent_log` partition pressure (high call volume) | Same partitioning posture as `recording_log`/`audit_log`/`drop_log`; F02 retention pattern proven. |

---

**End of C02 RESEARCH.md.** Next: `spec/modules/C02/PLAN.md`.
