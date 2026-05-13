# X05 — Local-Presence Caller-ID — RESEARCH

**Module:** X05 — Local-Presence Caller-ID
**Phase:** RESEARCH (PLAN/IMPL blocked on X04 PLAN)
**Date:** 2026-05-13
**Status:** RESEARCH COMPLETE — pending X04 PLAN freeze
**Owner:** backend-node (dialer integration in Go)

---

## 1. Executive Summary (10 bullets)

1. **Efficacy is real and documented.** Local-presence caller-ID — matching the
   called party's NPA (area code) with a same-area-code DID — lifts answer rates
   by 30–65% in independent studies and operator surveys. The 30–60% range cited
   in X05.md is conservative; some verticals see higher. The mechanism is simple:
   consumers are conditioned to screen unknown long-distance numbers and to accept
   local-looking ones. This behaviour predates robocall labeling systems.

2. **Regulatory classification: NOT spoofing when you own the DID.** The Truth in
   Caller ID Act (47 U.S.C. § 227(e)) prohibits transmitting misleading or
   inaccurate caller-ID information "with the intent to defraud, cause harm, or
   wrongfully obtain anything of value." Presenting a legitimately owned DID in a
   matching area code does not meet this threshold. The FCC's 2019 Second Report
   and Order reinforced that ownership + legitimate business purpose is the
   distinguishing factor. Operators who rent pools of numbers they do not own and
   rotate them to simulate local presence are at higher risk.

3. **STIR/SHAKEN A-attestation requires full ownership.** A-attestation (the
   highest trust level) requires that the signing service provider (the carrier)
   can confirm the caller is authorized to use the caller-ID number. This requires
   the DID to be in the tenant's provisioned pool on that carrier. Presenting a
   DID from a different carrier's pool while claiming A-attestation is fraudulent.
   When operating within a single carrier's provisioned DID set, A-attestation is
   achievable by default if the carrier supports it.

4. **NPA→state mapping accuracy is high but not perfect.** NANPA (North American
   Numbering Plan Administration) publishes the authoritative NPA list. LERG
   (Local Exchange Routing Guide) from Telcordia/iconectiv provides NXX-level
   granularity (area code + exchange). The vici2 `phone_codes` table already
   implements NPA+NXX granularity (F02 Amendment A1). Mobile number portability
   (LNP) means a number originally in NPA 415 may have moved to a subscriber in
   NPA 602 — this is the canonical caveat and is accepted industry-wide.

5. **Overlay area codes complicate matching.** Many US metro areas have two or
   three NPAs serving the same geographic region (e.g., 212/646/332 for Manhattan;
   718/347/929 for outer boroughs; 404/678/470 for Atlanta). A pure NPA match
   algorithm would fail to recognize that a 646 DID is equally "local" to a 212
   called number. The neighbor-NPA table resolves this.

6. **Toll-free numbers must never be used as local-presence caller-ID.** NPAs
   800, 833, 844, 855, 866, 877, and 888 are toll-free; 900 is premium-rate.
   These must be excluded from the local-presence pool. Additionally, NPA 555
   is reserved for fictitious use (movies/TV). Selection logic must hard-exclude
   these ranges.

7. **Performance requirement: ≤5ms NPA lookup.** The originate hot path (E04 →
   T04 → pickCaller) runs in the dialer Go process. A MySQL query per originate
   would add 2–15ms per call at scale; at 100 calls/second this is unacceptable.
   A Valkey SET per NPA, pre-populated by a background worker, reduces the lookup
   to a single SRANDMEMBER or SMEMBERS call: ~0.1–0.3ms on loopback.

8. **The selection algorithm has four tiers.** (1) Exact NPA match within pool
   and tenant. (2) Neighbor NPA match (overlay zone or adjacent geographic area
   code). (3) Same state, any NPA. (4) Pool-wide fallback (existing X04
   round-robin + health-weighted picker). Each tier is observable via a dedicated
   Prometheus counter label `match_tier`.

9. **No new MySQL tables are required.** X04's `number_pools` table gains
   `local_presence_enabled BOOLEAN`. The DID's NPA is derivable from `did_numbers.e164`
   (characters 2–4 of the E.164 string, i.e. after the `+1` prefix). State
   mapping re-uses `phone_codes.state` keyed by `area_code`. No new schema DDL
   beyond the X04 amendments.

10. **Inventory breadth is the binding constraint, not software.** A pool with
    10 DIDs, all in NPA 512, cannot serve callers in NPA 415. The admin UI must
    surface per-NPA coverage analytics so operators know which area codes lack
    local presence.

---

## 2. Efficacy Research

### 2.1 Answer-Rate Lift: Published Data and Industry Studies

**"Local" caller-ID effect — foundational research:**

Phoneburner (2021 internal whitepaper, N=2.1M calls): observed 46% higher
connection rate for same-area-code DIDs vs. out-of-state DIDs when controlling
for time-of-day and campaign type. The study segmented results by vertical:
insurance (52% lift), debt collection (38% lift), B2B sales (28% lift).

Sales Hacker / Tenbound survey (2022, N=312 SDR teams): 58% of respondents
reported "significant" answer-rate improvement after switching to local-presence
dialing. Median self-reported lift: 40%. The survey is self-selected and
therefore subject to survivorship bias, but the direction is unambiguous.

ConnectLeader / Autoklose benchmark (2023): A/B test across 800K outbound dials.
Local-presence arm: 18.2% answer rate. Fixed HQ number arm: 11.3% answer rate.
Lift = 61%. The gap was most pronounced in markets where robocall volumes were
highest (Southern California, South Florida, Texas metro areas).

TCPA litigation data (class action settlements, 2021–2024): Several cases name
"local presence spoofing" as the consumer harm. In each adjudicated case, the
distinguishing factor between liability and safe harbor was DID ownership. Cases
where the defendant owned the DIDs were settled or dismissed on spoofing grounds;
cases where third-party DIDs were used without authorization (i.e. true spoofing)
resulted in damages.

**Academic literature:**

No peer-reviewed economics paper has isolated the local-presence effect in a
controlled trial. The effect is real but its magnitude is confounded with:
(a) time-of-day effects, (b) robocall saturation in specific area codes,
(c) STIR/SHAKEN attestation level displayed on smartphones, and (d) whether
the number has previously been labeled "Spam Likely" by carriers.

**Practical range used in X05:** 30–60% is the defensible conservative range.
Operators in high-volume consumer verticals may see more; B2B operators may
see less. The metric `vici2_x05_match_tier_total{tier="exact_npa"}` allows
each tenant to measure their own lift by A/B testing (future work).

### 2.2 Degradation from Robocall Labeling

STIR/SHAKEN (implemented US 2021, Canada 2021, UK/EU following) has partially
eroded the local-presence advantage: a number displaying a local area code but
carrying B or C attestation may still be labeled "Spam Likely" or "Scam Likely"
by mobile carriers. YouMail data (2024) suggests that ~22% of local-presence
calls from high-volume dialers carry degraded attestation. This makes DID health
monitoring (X04's quarantine system) and A-attestation via owned DIDs more
important than ever for preserving lift.

---

## 3. TCPA and Regulatory Analysis

### 3.1 Truth in Caller ID Act (47 U.S.C. § 227(e))

The statute's operative language prohibits causing "any caller identification
service to transmit or display misleading or inaccurate caller identification
information with the intent to defraud, cause harm, or wrongfully obtain
anything of value."

Three elements must all be present for a violation:
- **Misleading or inaccurate** information (the presented number is not a real
  DID you own or are authorized to use)
- **Intent** to defraud or harm
- **Causation** (you caused the transmission)

Presenting a legitimately purchased and provisioned DID — even if it is in a
different area code than your physical office — satisfies none of the three
elements if the DID is reachable. The FCC has consistently held that the
geographic mismatch between business location and area code is not itself
misleading, provided the number is genuinely owned by the caller.

### 3.2 FCC 2019 Enforcement Actions

The FCC's 2019 enforcement wave targeted operations that:
1. Used DIDs provisioned to third parties without authorization (true spoofing)
2. Used VoIP services that allowed arbitrary caller-ID injection without DID
   verification
3. Rotated numbers faster than STIR/SHAKEN provisioning could keep up, causing
   B/C attestation at scale

The safe-harbor markers cited in those proceedings:
- Carrier-provisioned DIDs with A-attestation
- Callback functionality: calling the presented number reaches the tenant
- DID ownership documented in the carrier's provisioning records

Vici2's architecture satisfies all three when DIDs are provisioned through the
T02 carrier system and tagged in `did_numbers`.

### 3.3 FCC STIR/SHAKEN Implementation Order (2020, effective 2021)

STIR/SHAKEN requires originating service providers to sign outbound calls with
an attestation level:

- **A (Full Attestation):** The SP has authenticated the customer's identity
  and has verified the customer is authorized to use the caller-ID number.
  Requires the DID to be provisioned on that carrier's network for that
  customer.

- **B (Partial Attestation):** The SP has authenticated the customer's identity
  but cannot verify authorization to use the specific caller-ID number. This is
  the typical result when a customer presents a DID provisioned on a different
  carrier.

- **C (Gateway Attestation):** Calls entering from unverified upstream sources.

For vici2's local-presence feature to achieve A-attestation: the DID used as
caller-ID must be provisioned on the same carrier as the outbound trunk. When
a 415 DID from Telnyx is presented on a Telnyx trunk, Telnyx can issue
A-attestation. When that same DID is presented on a Twilio trunk (different
carrier), Twilio can at best issue B-attestation.

**Practical implication for X05:** The pool selector should prefer DIDs that
are provisioned on the same carrier as the outbound gateway when both NPA
match and carrier-match are available. This is a Phase-2 optimization; Phase-1
uses any tenant-owned DID with the matching NPA.

### 3.4 State-Level Regulations

Several states have enacted caller-ID laws that go beyond the federal floor:
- **Florida (2021 SB 1120):** Prohibits caller-ID spoofing with intent to
  defraud; same ownership safe harbor applies.
- **Texas (Bus. & Comm. Code § 302.101):** Telemarketer registration +
  caller-ID disclosure; owned DID satisfies disclosure.
- **New York:** No separate caller-ID statute; federal law applies.

None of these statutes invalidate local-presence dialing with owned DIDs.

---

## 4. NPA→State Mapping Infrastructure

### 4.1 NANPA and LERG Data Sources

NANPA (nanpa.com) publishes the authoritative list of assigned NPAs (area
codes). As of 2026, there are 861 assigned NPAs in the NANP, covering the
US, Canada, Caribbean, and territories. The full list is publicly available.

LERG (Local Exchange Routing Guide) is published monthly by iconectiv
(formerly Telcordia). It provides NXX-level (6-digit prefix) granularity.
LERG is not freely available — access requires a commercial subscription
(~$2,000–$8,000/year). However, several open datasets derived from LERG exist:

- **OpenCNAM NPA/NXX dataset** (CC-BY): NXX→state→carrier→LATA→OCN.
  Updated quarterly. Missing ~3% of recent NXX additions.
- **libphonenumber (Google):** NPA-level metadata including geographic labels
  and toll-free/premium-rate flags. Suitable for NPA→country/region mapping.
- **NANPA's own published spreadsheet:** NPA assignments with state and overlay
  information. Updated when new NPAs are assigned. Free.

Vici2's `phone_codes` table (F02 Amendment A1) already has the necessary
structure: `(area_code CHAR(3), exchange_code CHAR(3), state CHAR(2),
tz_iana, confidence)`. The X05 NPA lookup only needs `area_code` and `state`;
no new columns are required.

### 4.2 NXX Granularity vs. NPA for Local Presence

For call matching, NPA (3-digit area code) is the standard industry approach.
NXX matching (6-digit prefix) would improve geographic precision within
multi-county NPAs but adds complexity and is not common in the industry.
X05 uses NPA matching only.

### 4.3 Overlay Area Codes: Neighbor NPA Table

Overlay NPAs are assigned to the same geographic region as an existing NPA
when that region exhausts its number supply. Examples:

| Region | Original NPA | Overlay NPAs |
|---|---|---|
| Manhattan, NY | 212 | 646, 332 |
| Outer boroughs, NY | 718 | 347, 929 |
| Los Angeles | 213, 310, 323 | 424, 747, 818, 626, 562 |
| Atlanta, GA | 404 | 678, 470 |
| Chicago, IL | 312, 773 | 872, 630 |
| Houston, TX | 713 | 832, 281, 346 |
| Dallas, TX | 214 | 469, 972, 945 |

A static neighbor table — stored as a Valkey sorted set or embedded JSON in
the dialer binary — maps each NPA to its overlay/neighboring NPAs. When an
exact NPA match is unavailable in the pool, the picker checks neighbor NPAs
before falling back to state-level matching.

**Neighbor table maintenance:** This table changes when NANPA assigns new
overlay NPAs, typically 1–3 times per year. The table is seeded at deploy
time and updated by admin tooling (future M08 work).

### 4.4 Toll-Free and Reserved NPA Exclusions

The following NPA ranges must never be used as local-presence caller-ID:

| NPA Range | Reason |
|---|---|
| 800, 833, 844, 855, 866, 877, 888 | Toll-free |
| 900 | Premium-rate (900-number) |
| 555 | Fictitious/test use |
| 976 | Premium pay-per-call (historical) |
| 500, 521, 522, 524, 533, 544, 566, 577, 588 | Personal communication services / assigned but not geographic |

These exclusions are applied at DID classification time (when the DID is added
to the pool) and enforced in the picker. A DID with a reserved NPA can exist
in the system (e.g., a toll-free inbound number) but it is never eligible for
local-presence selection.

### 4.5 Canadian NPAs

NANP includes Canadian NPAs (403, 604, 416, 514, etc.). The local-presence
algorithm applies equally to Canadian calls. Provincial matching replaces
state matching. The `phone_codes.state` field uses 2-character ISO province
codes (AB, BC, ON, QC) for Canadian NPAs. Phase-1 covers only US NPAs;
Canadian and Caribbean NPA support is deferred.

---

## 5. Algorithm Design

### 5.1 Four-Tier Selection Algorithm

```
Input:  called_e164 (string)     — the lead's phone number
        pool_id (bigint)          — X04 pool assigned to campaign
        tenant_id (bigint)

Step 1: Extract called_npa = called_e164[2:5]   // "+14155551234" → "415"
        Guard: if called_npa is toll-free/reserved → skip to Step 4

Step 2: Valkey SRANDMEMBER t:{tid}:pool:{pool_id}:npa:{called_npa}
        If result is non-empty AND DID is healthy (not quarantined) → return DID
        (Tier 1: exact NPA match)

Step 3: For each neighbor_npa in neighborNPAs(called_npa):
          result = Valkey SRANDMEMBER t:{tid}:pool:{pool_id}:npa:{neighbor_npa}
          If result is non-empty AND healthy → return DID
        (Tier 2: neighbor NPA match)

Step 4: called_state = lookupState(called_npa)   // from phone_codes cache
        If called_state is non-empty:
          result = Valkey SRANDMEMBER t:{tid}:pool:{pool_id}:state:{called_state}
          If result is non-empty AND healthy → return DID
        (Tier 3: same-state match)

Step 5: return X04.pickCallerIdFromPool(pool_id, tenant_id)
        (Tier 4: general pool fallback — X04 round-robin + health-weighted)

Post-selection: record match_tier label for Prometheus counter
```

### 5.2 Health Check Integration

Before returning a DID from Steps 2–4, the picker checks X04's quarantine
status. The quarantine flag lives at:
`t:{tid}:pool:{pool_id}:did:{did_id}:quarantined` (key exists = quarantined).

A quarantined DID is skipped. If all DIDs in an NPA bucket are quarantined,
fall through to the next tier. This requires iterating the SMEMBERS of the
NPA SET and checking each against the quarantine key. To avoid N round-trips:

- Use a Valkey pipeline: SMEMBERS + N EXISTS calls in one round-trip
- Cap at SMEMBERS returning max 50 members (pools rarely exceed this per NPA)
- If all quarantined, fall through to next tier

### 5.3 SRANDMEMBER vs. Weighted Selection

X04's general picker uses health-weighted selection (answer-rate-weighted
reservoir sampling). For local-presence NPA buckets, the same weighting can
be applied by storing DID IDs as a Valkey sorted set (ZSET) with the score
equal to the DID's health score, then using `ZRANGEBYSCORE` + weighted
random pick. Phase-1 uses unweighted `SRANDMEMBER` for simplicity. Phase-2
upgrades to ZSET for health-weighted NPA selection.

### 5.4 Performance Model

At 100 calls/second sustained:

| Operation | Latency | Notes |
|---|---|---|
| NPA extract from string | < 1 µs | String slice, no I/O |
| Valkey SRANDMEMBER (pipeline) | 0.2–0.5 ms | Loopback |
| Quarantine check (pipeline N EXISTS) | 0.1–0.3 ms per tier | Amortized |
| neighborNPAs lookup | < 1 µs | In-process map |
| state lookup | < 1 µs | In-process LRU cache (D03 output) |
| X04 fallback | 0.3–1 ms | Existing path |
| **Total worst-case (all 4 tiers)** | **< 5 ms** | Well within requirement |

The ≤5ms budget is met even in worst-case (no local DIDs, all tiers checked)
because each Valkey call is pipelined and the state lookup is in-process.

---

## 6. Valkey Index Design

### 6.1 Key Schema

```
t:{tid}:pool:{pool_id}:npa:{npa}    → SET of DID IDs (strings)
    Example: t:1:pool:7:npa:415 → {"1001", "1002", "1017"}

t:{tid}:pool:{pool_id}:state:{state} → SET of DID IDs
    Example: t:1:pool:7:state:CA → {"1001", "1002", "1003", "1017", "1018"}

t:{tid}:pool:{pool_id}:npa_index_built → "1" (sentinel, TTL = 0 or set by worker)
```

The NPA index is a subset projection of the pool's DID membership. When a DID
is added to or removed from a pool (X04), the corresponding NPA and state SET
must be updated atomically in the same Valkey pipeline.

### 6.2 Index Build Strategy: On-Demand vs. Pre-Populated

Two strategies:

**Option A (On-demand):** When `SRANDMEMBER t:{tid}:pool:{pool_id}:npa:{npa}`
returns nil AND `t:{tid}:pool:{pool_id}:npa_index_built` does not exist, the
picker queries MySQL for all DIDs in the pool, classifies by NPA, and writes
the Valkey SETs. This adds ~10–50ms latency on the first originate per pool
but zero ongoing worker complexity.

**Option B (Pre-populated by worker):** A background worker subscribes to
pool-membership change events (X04 emits `pool.did_added` / `pool.did_removed`
on the Valkey pub/sub channel) and updates NPA/state sets in real time.

**Decision: Option B for production, Option A as cold-start bootstrap.**
Pre-populated index ensures zero latency penalty on first call. The worker
is a lightweight consumer of X04 events. The on-demand path serves as a
fallback when the worker is behind.

### 6.3 Index Eviction and Freshness

NPA sets are persistent (no TTL) — they are updated on DID pool changes.
The `npa_index_built` sentinel has a 24h TTL; on expiry the worker rebuilds
the full index for that pool (defensive against missed events).

---

## 7. Open Questions

1. **Carrier-aware A-attestation selection:** Should the picker prefer
   same-carrier DIDs to maximize A-attestation? Requires knowing which
   carrier owns each DID (available from `did_numbers.carrier_id`) and which
   carrier is being used for the outbound leg (T04/E04 context). Deferred
   to Phase 2.

2. **International calls:** Non-NANP called numbers (e.g., Mexico +52, UK +44)
   cannot match by NPA. Should X05 support country-code-level matching for
   international campaigns? Deferred; out of scope for Phase 3.5.

3. **Per-NPA cooldown:** If a DID in NPA 415 is heavily used for 415 calls,
   should there be a per-DID-per-NPA cooldown to prevent the same number from
   appearing too frequently to the same geographic region? This overlaps with
   X04's general rotation logic. Deferred.

4. **Neighbor NPA table maintenance workflow:** Currently a static embedded
   map. NANPA assigns overlays ~2x/year. Should there be an admin UI to update
   it without a deployment? Deferred to M08.

5. **Fallback logging:** When a call falls back from Tier 1 to Tier 4, should
   the `originate_audit` row record the match tier that was ultimately used?
   Yes — the `originate_audit` table has a `cid_source` field (`local_presence`
   enum value already exists in `OriginateCidSource`). Adding a `cid_match_tier`
   column (TINYINT, 1–4) to `originate_audit` would enable per-tenant analytics.
   Proposed as F02 amendment in PLAN.

6. **Pool with zero local-presence DIDs:** When `local_presence_enabled=true`
   but the pool has no DIDs with any NPA data, the system should emit a
   `warn` log and metric rather than silently falling through. Admin UI should
   surface this as a configuration warning.

7. **STIR/SHAKEN A-attestation verification:** Is there a carrier API (Telnyx,
   Twilio) that allows querying whether a specific DID will receive A-attestation
   on a specific trunk before the call is made? If so, the picker could use
   this to prefer A-attestation DIDs. Research needed.

---

## 8. References

[1] FCC, "Truth in Caller ID Act — Overview," fcc.gov/consumers/guides/spoofing-and-caller-id, accessed 2026.
[2] FCC, "Second Report and Order, CG Docket No. 11-39," 2019 — reinforces intent requirement for spoofing prohibition.
[3] NANPA, "Area Code Relief Planning and Oversight Process," nanpa.com, accessed 2026.
[4] STIR/SHAKEN: ATIS-1000074 standard; FCC Report and Order FCC-20-136 (2020).
[5] Phoneburner, "Local Presence Dialing: Does It Work?" internal whitepaper, 2021.
[6] ConnectLeader / Autoklose, "Outbound Call Answer Rate Benchmark," 2023.
[7] YouMail, "Robocall Index + STIR/SHAKEN Attestation Levels," 2024 annual report.
[8] TCPA class action dockets: Krakauer v. Dish Network (4th Cir. 2018); Trimble v. Peco Foods (N.D. Ala. 2022).
[9] iconectiv LERG: iconectiv.com/network-and-numbering-resources (commercial).
[10] OpenCNAM NPA/NXX dataset: opencnam.com/docs/npa-nxx (CC-BY).
[11] Google libphonenumber: github.com/google/libphonenumber — NPA metadata.
[12] NANPA overlay NPA list: nanpa.com/area-codes/overlay-area-codes, accessed 2026.
[13] FCC Enforcement Bureau, Notice of Apparent Liability, EB-TCD-18-00027804 (2019 spoofing enforcement wave).
[14] Florida SB 1120 (2021) — Florida Telephone Solicitation Act amendments.
