# X04 — Number Pool + Rotation: Research

## 1. Background: The Spam Likely Problem

### 1.1 What "Spam Likely" Is

"Spam Likely" is a call-label applied by mobile carriers and analytics engines to outbound calls
before the recipient's phone rings. The label appears in the caller-ID display instead of (or
alongside) the calling number. On iOS it shows as "Spam Risk"; on Android as "Spam Likely"; on
carriers with integrated analytics (T-Mobile, AT&T, Verizon) it may be auto-silenced entirely.

The label is applied probabilistically, not deterministically. No single trigger causes it; a
composite score from multiple signals crosses a threshold specific to the analytics provider.

### 1.2 Analytics Ecosystem

Three independent analytics companies supply almost all US PSTN labeling data:

**First Orion** (powers T-Mobile Scam Shield, bundled on all T-Mobile handsets):
- Sources: subscriber complaint submissions, call-pattern anomaly detection, volume spikes,
  known-bad number lists purchased from law enforcement databases.
- Key signal: calls-per-hour from a single E.164 that receive no answer or result in immediate
  hang-up (answer + sub-3s hang-up). Called the "churn rate" internally.
- Remediation: First Orion's Branded Calling API (Business Caller ID) allows enterprises to
  register numbers and display a logo + brand name. Requires carrier agreement. Monthly fee
  per number ($0.005–0.01/call depending on tier).
- Threshold (public estimates): typically 50–100 calls/hour/number before scoring increases
  materially. Above 200 calls/hour the label can appear within hours.

**Hiya** (powers Samsung default dialer, Google Pixel, Google Phone app, AT&T Call Protect):
- Sources: crowd-sourced reports from Hiya app users (30M+ monthly active), enterprise
  subscriber feeds, partner carrier CDRs.
- Key signals: answer rate below baseline for the number type (geographic vs toll-free), short
  call durations (< 4s average), high volume-to-answer ratio.
- Hiya Protect API: REST endpoint for enterprises to whitelist numbers, submit brand info,
  check current label. Free tier: 100 lookups/day. Paid: $500+/month per company.
- Threshold: Hiya does not publish exact thresholds. Industry consensus: answer rate < 10%
  over a rolling 7-day window of 500+ calls is a strong predictor.

**TNS (Transaction Network Services) / Call Guardian**:
- Powers Verizon Call Filter, T-Mobile (secondary), various regional carriers.
- Sources: CDR feeds from carrier partners (the biggest structural advantage — TNS sees actual
  call completions, not just originations), subscriber opt-in reporting.
- TNS has the lowest false-positive rate because it uses completion data. Numbers with high
  churn (many originations, few completions) score higher.
- Enterprise access: TNS Reputation Dashboard ($1,500+/month). REST API for reputation
  lookups and opt-out of erroneous labels.

### 1.3 Vicidial's Approach to outbound_cid Rotation

Vicidial stores outbound caller-ID at the campaign level (`campaigns.campaign_cid`). For many
years this was a single static field. Beginning around 2019, community patches (now mainlined)
added:

- `outbound_cid_type` — enum: `campaign`, `agent_cid`, `campaign_dnc_cid`, `saved_dnc_cid`,
  `manual_dial_cid`, `random`, `sequential`.
- `outbound_cid_group` — FK to a `outbound_cid_groups` table (introduced in Vicidial 2.14).
- `outbound_cid_groups` table — stores a list of E.164 numbers associated with a campaign.
  Each row has: `group_id`, `phone_number`, `active`, `added_epoch`, `call_count`, `answer_count`.
- Selection: when `outbound_cid_type = random`, Vicidial picks a random active row from
  `outbound_cid_groups` for the campaign. When `sequential`, it tracks a pointer via a separate
  campaign-level counter column.
- Health tracking: Vicidial records `call_count` and `answer_count` per number. No built-in
  quarantine mechanism — operators must manually deactivate numbers via the admin UI.
- Rate limiting: none built-in; all anti-spam measures are manual.

This design has well-known deficiencies in the open-source community:
- No automatic quarantine: a labeled number continues to be used until a human notices.
- No per-number daily cap: numbers can be hammered at full campaign concurrency.
- No complaint-rate tracking: the `answer_count`/`call_count` ratio doesn't capture STIR
  attestation changes or complaint signals.
- No pool isolation between campaigns: the same number group can be shared across campaigns,
  causing cross-contamination of reputation signals.

vici2 addresses all of these gaps via X04.

---

## 2. STIR/SHAKEN and Its Impact on Labeling

### 2.1 Framework Overview

STIR (Secure Telephone Identity Revisited) and SHAKEN (Signature-based Handling of Asserted
information using toKENs) were mandated by the FCC for US originating carriers under the TRACED
Act (effective June 30, 2021). The framework cryptographically signs outbound calls with a PASSporT
(Personal Assertion Token) carried in the SIP Identity header.

The PASSporT contains:
- `attest`: attestation level (A, B, or C).
- `orig.tn`: the asserted originating number.
- `dest.tn`: the destination number.
- `iat`: issuance timestamp (Unix epoch, seconds).
- Signature: RS256 over the canonical JSON, using the carrier's certificate chain anchored to
  the SHAKEN certificate authority.

### 2.2 Attestation Levels

**Level A (Full Attestation)**:
- The carrier certifies that: (1) it is the customer's authorized service provider, (2) the
  customer is authorized to use the calling number, and (3) the calling number can be
  authenticated by the carrier's subscriber records.
- Requires the number to be in the carrier's provisioned DID portfolio for that customer.
- Analytics engines (Hiya, First Orion, TNS) give full-attestation calls significantly higher
  "trust score" baselines. A new number that has never been labeled and has A-attestation will
  start with a much larger reputation budget.

**Level B (Partial Attestation)**:
- Carrier certifies the call originated from its network and the customer is the carrier's
  subscriber, but it does not certify the customer is authorized to use the specific calling
  number. Common when customers forward or spoof numbers provisioned through a third-party
  carrier.
- Moderately trusted. Analytics engines apply a penalty (~15–25% trust score reduction) vs A.
- vici2 callers using BYOC SIP trunks where the SIP provider (Twilio, Bandwidth, Vonage,
  SignalWire) provisions the DID but the vici2 tenant originates calls from their own FreeSWITCH
  typically receive B attestation because the PSTN ingress carrier (Twilio, etc.) recognises the
  number but the final SIP originator is downstream.

**Level C (Gateway Attestation)**:
- Carrier can only certify the call entered its network at a particular gateway; it cannot
  verify the subscriber or the number.
- Heavily penalized by analytics engines. A number with only C-attestation behaves similarly to
  an unverified/unsigned call in terms of reputation scoring.
- STIR/SHAKEN signatures can still be applied at Level C — they are not omitted — but the
  `attest` field value tells downstream analytics the verification level.

### 2.3 Practical Implications for X04

To achieve A-attestation with BYOC SIP trunks:
1. The DID must be provisioned directly on the terminating carrier's account (Twilio, Bandwidth,
   etc.) that owns the SBC the FreeSWITCH points to.
2. The carrier must support STIR/SHAKEN A-attestation for BYOC originators (not all do).
3. The E.164 in the From/P-Asserted-Identity header must exactly match the provisioned DID.

X04 should record attestation level per DID (`attest_level ENUM('A','B','C','unknown')`) and
use it as an input to the health score. A-attested numbers receive a higher starting reputation
budget and slower health decay rate.

---

## 3. Per-Number Health Metrics

### 3.1 Key Metrics

**Answer Rate (AR)**:
- Definition: `live_answer_count / total_outbound_calls` over a rolling window.
- Industry baseline for outbound call centers: 15–30% (varies heavily by vertical and list quality).
- Threshold for quarantine: AR < 8% over a minimum sample of 200 calls (configurable per pool).
- The minimum sample guard prevents quarantining a new number after 5 calls with 0 answers.
- Rolling window: 7 days is the standard industry window; analytics engines weight recent calls
  more heavily. vici2 will track daily buckets and sum them over 7d.

**Complaint Rate (CR)**:
- Definition: number of STIR/SHAKEN "unwanted call" reports divided by total calls over 30d.
  In practice, vici2 receives complaint signals indirectly: carriers report them via TNS
  Reputation Lookup responses, or via the Hiya API. Without a direct carrier feed, vici2
  approximates CR via AMD (answering machine detection) abandoned rate and very-short-call rate.
  A direct FCC complaint (filed at donotcall.gov) will appear in TNS data within 24h.
- Threshold for quarantine: CR > 2% over 30 days.
- In vici2 Phase 3.5 without a carrier-data subscription, CR is approximated: count calls where
  answer was confirmed (human) but duration < 4s as a proxy for "immediate hang-up on answer"
  which strongly correlates with complaint behavior.

**Daily Call Count (DCC)**:
- Total outbound calls placed with this number as caller-ID today (UTC calendar day).
- Daily cap enforcement: max 150–300 calls/day per number is a widely-used industry heuristic to
  avoid triggering volume-based labeling. The exact cap depends on the analytics provider;
  First Orion's documented behavior suggests 200 calls/day is a conservative safe threshold.
- Implementation: Valkey counter with a TTL expiring at midnight UTC.

**Age (days_since_first_use)**:
- How long the number has been active in any pool.
- Newly provisioned numbers have 0 reputation. Analytics engines apply a "new number penalty"
  similar to new credit accounts. Recommend warming new numbers: ≤ 20 calls/day for the first
  7 days, ≤ 50 calls/day for days 8–14, then full cap. This is the "warm-up ramp."
- Tracked in `number_pool_dids.first_used_at`.

**Days Since Last Use (recency)**:
- A number unused for 90+ days may have been re-assigned by the carrier to another customer.
  Re-assigned numbers can inherit negative reputation from the previous owner.
- Also: analytics engines may purge positive reputation scores for dormant numbers.
- vici2 should surface "stale" numbers (last_used_at > 60 days) in the admin UI with a warning.

**Concurrent Call Count**:
- How many calls are currently in-flight using this number as caller-ID.
- Carriers flag numbers that originate many concurrent calls (> 5–10 simultaneous is suspicious
  for most geographic numbers). Toll-free numbers are exempted.
- X04 enforces a per-number concurrent cap via a Valkey INCR/DECR pattern (similar to the
  existing gateway_cap gate in T04).

### 3.2 Composite Health Score

A weighted composite score [0, 100] used to rank numbers during weighted-random selection:

```
health_score = (
  0.40 * answer_rate_score +      // normalized: AR/0.25 capped at 1.0
  0.25 * (1 - complaint_rate_score) + // 1 - CR/0.05 clamped [0,1]
  0.20 * attestation_bonus +      // A=1.0, B=0.7, C=0.3, unknown=0.5
  0.15 * warmup_penalty           // 1.0 if warmed, ramp function during warm-up
) * 100
```

Numbers below threshold_score (default: 25) are candidates for quarantine.
Numbers with `quarantined = true` are excluded from selection entirely.

---

## 4. Rotation Strategies

### 4.1 Random

Select a random active, non-quarantined number from the pool. Simple, avoids sequential
patterns that carriers might detect. Weakness: can select the same number twice in a row;
no protection against hot-spotting in low-pool-size scenarios.

### 4.2 Sequential (Round-Robin)

Maintain a per-campaign integer pointer. Advance it modulo pool size on each pick. In a
multi-instance deployment (multiple dialer pods) this requires a shared atomic counter in
Valkey. Valkey's INCR is atomic. The key pattern: `t:{tid}:pool:{pool_id}:rr_cursor`.

Advantage: guarantees uniform distribution across numbers in the pool.
Weakness: if pool is small, sequential patterns in CDR data may be detected by carrier analytics
(though this concern is largely theoretical; carrier analytics work on per-number volumes, not
sequential patterns across numbers).

### 4.3 Least-Recently-Used (LRU)

Track `last_used_at` per number. Always pick the number with the oldest `last_used_at`. In
practice this degenerates to round-robin for pools where all numbers are called at similar rates.
Advantage: ensures the maximum time gap between reuse of any single number.
Implementation: maintain a sorted set in Valkey (`ZADD` score = Unix timestamp) for real-time
O(log N) LRU selection.

### 4.4 Health-Weighted Random (Recommended Primary Strategy)

Assign selection weights proportional to health score. Numbers with higher health scores are
more likely to be selected but not exclusively. Uses the classic weighted-random-selection
algorithm (binary search on cumulative weight array).

Combines the advantages of random distribution with bias toward high-performing numbers.
In small pools (< 5 numbers) this degenerates toward deterministic selection of the best number;
operator should be warned when pool size is small.

**Implementation detail**: health scores change infrequently (updated by the quarantine reaper
every 1h). The weight array can be cached in the dialer process memory and invalidated via a
Valkey pub/sub event when the reaper runs. This avoids a DB query on every call.

### 4.5 Recommended: LRU + Health-Weighted Hybrid

1. Filter: exclude quarantined, cap-exceeded, concurrent-limit-exceeded numbers.
2. Score: multiply health_score by (1 / (now_unix - last_used_at_unix + 1)) for a time-decayed
   preference toward numbers used least recently.
3. Select: weighted random from the filtered+scored set.

This hybrid is the default X04 strategy. Pool-level config allows overriding to `random`,
`round_robin`, or `least_recently_used` for operators with simpler needs.

---

## 5. Quarantine Mechanics

### 5.1 Triggers

Auto-quarantine is triggered by the quarantine reaper (1h cron in workers) when any of:
1. **Low answer rate**: AR < pool.ar_floor (default 8%) AND call_count_7d ≥ pool.min_sample (default 200).
2. **High complaint proxy**: short_call_rate_30d > pool.cr_ceil (default 5%) AND call_count_30d ≥ 100.
3. **Daily cap breached**: this is not quarantine — the number is simply excluded from selection
   today. The next calendar day it is eligible again.
4. **Manual quarantine**: admin uses the UI to quarantine a specific number.
5. **Label detection** (future / Phase 4): if vici2 subscribes to a reputation API (Hiya,
   TNS), an explicit "Spam Likely" label response triggers immediate quarantine.

### 5.2 Auto-Unquarantine

vici2 does NOT auto-unquarantine numbers. Unquarantine is always a manual admin action. This
is intentional: auto-unquarantine risks cycling a bad number back into production if the
metrics revert briefly (e.g., on a weekend with less call volume). The admin must affirm.

The admin UI shows:
- Why the number was quarantined (reason code + metric values at quarantine time).
- Current metric snapshot (to show whether the situation has improved).
- A button "Unquarantine" which immediately restores the number to active status.
  This emits a `number_pool.did.unquarantined` audit event.

### 5.3 Pool Auto-Replenishment

When quarantine leaves a pool below its configured minimum size (`pool.min_active_size`), the
system can optionally request new DID provisioning from the carrier.

Programmatic DID provisioning APIs:

**Twilio**: REST API `POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/Local`.
  - Search: `GET /AvailablePhoneNumbers/{CountryCode}/Local?AreaCode=...&SmsEnabled=false`
  - Provision: POST to IncomingPhoneNumbers with PhoneNumber + VoiceUrl (webhook) or SipDomain.
  - Price: $1.00/month/number (US local). Charged immediately on provision.

**Bandwidth**: REST API `POST /accounts/{accountId}/phoneNumbers`.
  - Search: `GET /accounts/{accountId}/availableNumbers?areaCode=...`
  - Price: varies by plan. Typically $0.35–0.60/month/number.

**Vonage/Nexmo**: `POST /number/buy` with country, msisdn (selected from search).
  - Search: `GET /number/search?country=US&type=landline-toll-free&features=VOICE`

**SignalWire**: compatible with Twilio API shape — same endpoint structure.

In X04 Phase 3.5: auto-replenishment is modelled but not automatically executed. The system
will alert admins ("Pool X is below minimum size — consider provisioning new numbers") via the
existing O03 alerting infrastructure. A future module (X06) can add automatic provisioning.

---

## 6. Multi-Tenant Pool Isolation

Each tenant has its own isolated set of pools. A DID number (`did_numbers` row) belongs to exactly
one tenant. A pool belongs to one tenant. A DID can be a member of multiple pools within the same
tenant (e.g., a shared backup number used across campaigns). Cross-tenant number sharing is
prohibited at the schema level via `tenant_id` checks on all queries.

When a DID is quarantined in one pool but active in another pool within the same tenant, the
quarantine applies globally to the DID (not per pool-membership). This is intentional: if a
number has earned a bad reputation in any context, it should not continue to be used. The
quarantine flag lives on the `did_numbers` table (or on `number_pool_dids` — see PLAN for the
schema decision).

**Schema decision recorded in PLAN §3**: quarantine flag lives on `number_pool_dids` (the M:N
join table), not on `did_numbers`. Rationale: a number used for inbound routing (`route_kind =
ingroup`) should not be quarantined from inbound just because its outbound reputation degraded.
The quarantine semantics are pool-membership-specific. However, a cross-pool quarantine view is
provided in the admin UI ("this number is quarantined in 2 of 3 pools").

---

## 7. Existing T02 Schema (did_numbers table)

From `api/prisma/schema.prisma` lines 1163–1185:

```prisma
model DidNumber {
  id            BigInt       @id @default(autoincrement())
  tenantId      BigInt       @default(1)   @map("tenant_id")
  e164          String       @db.VarChar(16)
  carrierId     BigInt       @map("carrier_id")
  routeKind     DidRouteKind @map("route_kind")
  routeTarget   String       @map("route_target") @db.VarChar(64)
  callerIdName  String?      @map("caller_id_name") @db.VarChar(64)
  active        Boolean      @default(true)
  defaultLang   String       @default("en") @map("default_lang") @db.VarChar(5)
  ivrTimeoutSec Int          @default(300) @map("ivr_timeout_sec") @db.UnsignedSmallInt
  createdAt     DateTime     @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt     DateTime     @updatedAt @map("updated_at") @db.DateTime(6)

  @@unique([tenantId, e164])
  @@map("did_numbers")
}
```

The table has no per-number health statistics. X04 adds health columns to this table (see PLAN
§3.1 for the migration amendment) rather than creating a separate stats table, because the
one-to-one relationship between a DID and its aggregate health stats makes embedding the most
efficient query path.

---

## 8. Existing cid_picker.go Waterfall

From `dialer/internal/originate/cid_picker.go`:

```go
// Tier 1: per-call override
// Tier 2: per-list override (F02 AMENDMENT T04.3+T04.4)
// Tier 3: local-presence (X05, Phase 3.5 — stub returns nil/miss in Phase 1)
// Tier 4: campaign default
```

X04 inserts at **Tier 3 (pool rotation)**, between the list override and the campaign default.
The existing `CidSourceLocalPresence` constant is already defined in `request.go` and maps to
this tier. X04 implements the pool picker behind this tier; X05 (local-presence) reuses X04
pools with area-code affinity logic layered on top.

The pool picker is called only when:
- The campaign has `number_pool_id IS NOT NULL`.
- Tiers 1 and 2 have not supplied a CID.

---

## 9. Adjacent Module Interfaces

### 9.1 T02 (DID management)
- `api/src/routes/admin/dids/` — CRUD for `did_numbers`.
- X04 adds DIDs to pools via `number_pool_dids` (M:N join) without modifying the T02 service.
  The T02 `listDids` endpoint will be extended with a filter `?poolId=X` in X04.

### 9.2 E02 (originate caller-ID selection)
- `dialer/internal/originate/cid_picker.go` — the `PickCallerID` function.
- X04 adds `PickFromPool(ctx, poolID, tenantID) (e164, error)` to a new package
  `dialer/internal/pool/` and wires it into `cid_picker.go`'s Tier 3 slot.
- The `OriginateRequest` must carry `NumberPoolID int64` (0 = no pool assigned).

### 9.3 X05 (Local Presence — planned parallel module)
- X05 builds on X04 pools: for local-presence, the pool is filtered to only numbers with
  area codes matching the destination's area code.
- X04 exposes: `PickFromPool(ctx, poolID, tenantID, areaCodeFilter string)`.
- X05 provides the area-code filter string; X04 applies it. This keeps X04 unaware of
  local-presence semantics.

### 9.4 M06 (Carrier/DID admin UI)
- The DID list page (`(admin)/dids`) will link to pool membership: "Member of pools: X, Y".
- X04 adds `(admin)/number-pools` pages (list, create, edit, view-stats).

---

## 10. Open Questions

1. **Complaint-rate data source**: Without a carrier subscription (Hiya API, TNS Reputation
   Dashboard), X04 can only approximate complaint rate via short-call heuristics. Should Phase
   3.5 include an integration stub for Hiya/TNS webhooks? Decision needed before implementation
   starts. Recommendation: include the `complaint_count_30d` column in schema now (default 0),
   allow manual admin increment, and wire actual API integration in a future X07 module.

2. **Attestation-level auto-detection**: Can vici2 detect the attestation level of a SIP call
   by parsing the Identity header returned on 200 OK or by querying the carrier's API?
   FreeSWITCH ESL exposes the full SIP headers. The Identity header is present on outbound
   calls that go through a STIR/SHAKEN-capable carrier. Parsing it requires a JWT decode of
   the PASSporT. In scope for X04? Recommendation: out of scope for Phase 3.5; add to X07.
   For now, `attest_level` is admin-configured per carrier or DID.

3. **Warm-up ramp enforcement**: should the warm-up ramp be enforced as a hard cap (max 20
   calls/day for a new number's first 7 days) or as a soft advisory? Recommendation: hard cap
   enforced via the Valkey daily counter with a dynamically computed cap based on age.

4. **Cross-pool quarantine propagation**: if a DID is quarantined in one pool, should it be
   automatically quarantined in all other pools for the same tenant? Current decision: no
   automatic cross-pool propagation; the reaper evaluates each pool membership independently.
   The admin UI surfaces cross-pool quarantine state clearly.

5. **Local-presence integration depth**: X05 is planned in parallel. Does X04 need to solve
   the area-code indexing problem now, or can X05 simply apply a post-filter to X04's output?
   Recommendation: X04 exposes an `areaCodeFilter` parameter; X05 passes it. X04 stores
   `area_code CHAR(3)` on `number_pool_dids` (denormalized from `e164`) for fast filtering.

6. **Pool assignment on campaigns**: campaigns currently have `callerIdCarrierId` (FK). X04
   adds `numberPoolId`. These are mutually exclusive in practice (pool overrides carrier-level
   CID). Should the schema enforce this with a CHECK constraint? Recommendation: no DB
   constraint; application layer enforces "if pool assigned, pool wins over campaign CID".

7. **Metrics retention**: how long should per-number daily call buckets be retained? 90-day
   retention (matching typical call center regulatory record-keeping). Older buckets are pruned
   by the quarantine reaper.

---

## 11. Industry Research References (from training knowledge)

The following reflects accumulated knowledge from public sources including:
- FCC STIR/SHAKEN Implementation Guide (2021): https://www.fcc.gov/call-authentication
- ATIS-1000074.v004 SHAKEN specification
- First Orion "State of Robocalling" annual reports
- Hiya developer documentation (Hiya Protect API)
- TNS Call Guardian documentation
- Vicidial open-source codebase (vicidial.com/vicidial-svn) — `DB_functions.pl`, admin
  screens `outbound_cid_groups.php`
- Twilio Programmable Voice REST API docs — IncomingPhoneNumbers resource
- Bandwidth API docs — Account Phone Numbers
- FTC/FCC complaint databases (CGAB complaint data)
- Industry best-practice guides from PACE (Professional Association for Customer Engagement)
  and ATA (American Teleservices Association)

Note: Exa web search was unavailable at research time (quota exceeded). All content above
is based on Anthropic model training data (knowledge cutoff: August 2025). Implementers
should verify current pricing and API shapes against live carrier documentation before
the implementation phase.
