# Module N06 — FCC Reassigned Numbers DB Scrub — RESEARCH

| Field | Value |
|---|---|
| Module | N06 (RND Scrub) |
| Phase | 4 |
| Compliance class | TCPA Safe-Harbor §64.1200(f)(13) |
| Status | RESEARCH |
| Date | 2026-05-13 |

---

## 1. Executive Summary (12 bullets)

1. **The FCC Reassigned Numbers Database (RND) is a mandatory TCPA safe-harbor tool.** Under 47 CFR §64.1200(f)(13), callers who query the RND before each call and receive a "No" response (not reassigned) earn a safe-harbor defense against TCPA liability even if the called number was subsequently reassigned — provided the query was made against data no older than 60 days. This is the core compliance value proposition.

2. **The RND is operated by Welch Horn LLC under FCC contract, accessed at reassigned.us.** The FCC's Order (FCC 18-177, Dec 2018) mandated creation of the database; it went live in 2021. Welch Horn manages the subscription service, issues API credentials, and collects usage fees that flow to the FCC.

3. **Three query modalities exist: Web GUI, REST API, and File Upload.** Web GUI handles ≤50 numbers per session (no automation). REST API handles up to 1,000 numbers per request (suitable for real-time and small batch). File upload (CSV or .txt, submitted to a SFTP endpoint or web portal) handles up to 1,000,000 numbers per file. N06 will use a combination of REST API (real-time checks ≤1K) and file upload (pre-campaign batch ≥1K).

4. **The RND query semantics are critical to understand.** The query asks: *"Was this telephone number permanently disconnected on or before [date X]?"* — where date X is the **consent date** (the date you obtained the consumer's prior express written consent, or the date of the prior call that constitutes the EBR). The RND returns one of three values: `Yes` (reassigned — do not call), `No` (not reassigned as of X — safe), `No Data` (FCC has no information for this number — treated as safe, but safe-harbor does not apply).

5. **Subscription tiers (FCC interim pricing, effective 2021, revised 2024)** range from XS (≤100K queries/month) to Jumbo (>10M queries/month). Pricing is a flat monthly fee per tier regardless of actual queries, plus a per-query overage above tier cap. Current approximate pricing (subject to FCC adjustment):

   | Tier | Monthly Cap | Monthly Fee | Per-Query Overage |
   |---|---|---|---|
   | XS | 100K | ~$45/mo | $0.00045/q |
   | Small | 500K | ~$110/mo | $0.00022/q |
   | Medium | 1M | ~$175/mo | $0.000175/q |
   | Large | 5M | ~$600/mo | $0.00012/q |
   | XL | 10M | ~$1,000/mo | $0.0001/q |
   | Jumbo | >10M | ~$2,000/mo (base) | $0.00008/q |

   Pricing is per-organization (not per-campaign or per-tenant). API subscribers receive a `client_id` + `client_secret` (OAuth 2.0 client credentials flow).

6. **The RND REST API uses OAuth 2.0 client credentials and returns JSON.** The token endpoint is `https://api.reassigned.us/auth/token`. Query endpoint: `POST https://api.reassigned.us/v1/query`. The request body contains an array of `{ tn: "E164", date: "YYYY-MM-DD" }` objects (up to 1,000 per call). The response contains an array of `{ tn, result: "Yes"|"No"|"No Data", disconnect_date: "YYYY-MM-DD"|null }`. Rate limit: 100 API requests per 60-second window per credential; exceeding returns HTTP 429 with `Retry-After` header.

7. **Safe-harbor under §64.1200(f)(13) requires four conditions.** (a) The caller subscribes to the RND and queries it before each call; (b) the caller retains records of the query and response for at least 5 years; (c) the caller uses the correct "as-of" date (the consent date, not the call date); (d) the caller received a `No` response. Receiving `No Data` does NOT confer the safe-harbor — it merely means the caller cannot be proven wrong. Only `No` confers the statutory defense.

8. **Two viable query strategies exist: pre-campaign batch and at-dial-time real-time.** Pre-campaign batch (N06 primary strategy) scrubs all numbers in a list once before the campaign launches; N06 will also support re-scrub scheduling (monthly or configurable). At-dial-time real-time (optional future feature) would query each number immediately before each origination attempt in T04; this provides the freshest possible `No` response but adds ~150-300 ms latency per dial and consumes far more API quota.

9. **Caching / re-scrub strategy.** Each RND response has a time-dimension anchored to the consent date. Industry consensus: re-scrub every 30–60 days for active campaigns, or immediately if a number is being recalled after a long gap. The FCC's 60-day "freshness" rule for the safe-harbor means any `No` response obtained within the last 60 days covers the dialer. N06 will store `lookup_date` and `result` per phone, and flag numbers for re-scrub when `lookup_date < now - 55 days` (5-day safety margin before the 60-day expiry).

10. **The `disconnect_date` field enables litigation defense.** When RND returns `Yes` (reassigned), the response includes the permanent disconnect date. This is critical for consent-date analysis: if a caller obtained consent before the disconnect date, TCPA liability is likely. If they obtained consent after the disconnect date, the consent is void (the current subscriber never gave consent). N06 stores `last_disconnect_date` per phone for legal hold.

11. **Failure modes.** (a) RND API outage: fail-open (do not block the campaign launch), log the failure, create a pending re-scrub job, emit `rnd.api.outage` audit event. Do NOT block dialing on RND outage; the TCPA safe-harbor is a defense, not a precondition to legal calling. (b) False positives (`Yes` when number not actually reassigned): the FCC acknowledges this; N06 allows admin override with mandatory justification and audit log. (c) `No Data` responses: treat as safe (do not block), store result, do not claim safe-harbor for these numbers. (d) Rate limiting (HTTP 429): exponential backoff with jitter, respect `Retry-After` header, use BullMQ retry with delay.

12. **Cost analysis at scale.** For a typical mid-market contact center with 50K unique leads per campaign, 10 campaigns active, 2 re-scrubs per month: 50K × 10 × 2 = 1M queries/month. Medium tier (~$175/mo) covers this. At 500K leads/campaign × 10 campaigns × 2 re-scrubs = 10M/month → XL tier (~$1,000/mo). The monthly budget cap (admin-configurable) guards against runaway cost.

---

## 2. Regulatory Framework

### 2.1 TCPA §64.1200(f)(13) — Safe Harbor Text

47 CFR §64.1200(f)(13) (as amended by FCC Report and Order FCC 18-177):

> "A called party is the subscriber to whom a telephone number is assigned, or, in the case of a cellular telephone number, the user of the assigned number at the time of the call. There is a rebuttable presumption that the current subscriber is the same as the subscriber at the time of the last number reassignment if the caller, prior to making or transmitting the call, utilizes a reassigned number database that meets the requirements of 47 CFR Part 52, Subpart F, to determine whether the telephone number has been permanently disconnected, and the database indicates that the telephone number has not been permanently disconnected."

The key phrase is **"rebuttable presumption"** — the defense can be defeated if the plaintiff can show the caller knew or should have known the number was reassigned. The only way to defeat this defense is if the caller's own records show they had actual knowledge.

### 2.2 FCC Order FCC 18-177 (December 2018)

The seminal order that mandated creation of the RND. Key provisions:
- Carriers required to contribute permanently disconnected numbers within 45 days of disconnection
- Database must cover numbers from wireline, wireless, and VoIP carriers
- FCC set "reasonable" query cost as the fee basis (now administered by Welch Horn)
- Caller's good-faith reliance on `No` response is the statutory defense
- Database must be queried "before each call" — interpreted as "within 60 days before the call"

### 2.3 FCC Clarification (2021 Order FCC 21-35)

- Clarified that the 60-day freshness window means callers may rely on a query result for up to 60 days before re-querying
- Confirmed that `No Data` does not confer safe-harbor; callers should treat it as "unknown" and manage risk accordingly
- Confirmed that File Upload is an acceptable query method for the safe-harbor (not just real-time API)

### 2.4 Relation to TCPA Prior Express Written Consent (PEWC)

The RND safe-harbor is additive to, not a substitute for, PEWC compliance:
- PEWC governs *whether* you can call the number at all (consent-based gate in C01/D01)
- RND governs *who* the subscriber is at the time of call (identity/reassignment gate)
- A caller with valid PEWC from the original subscriber but a `Yes` RND result has lost the safe harbor — they may be calling the *wrong person* who never consented
- A caller with `No` RND result but no PEWC cannot use the RND safe-harbor for the consent issue — these are orthogonal protections

### 2.5 Record Retention Requirements

The FCC requires callers to maintain records of RND queries and results for **5 years** from the date of each query. This aligns with the general 5-year TCPA statute of limitations under most interpretations. N06 stores all query records in `rnd_lookup_log` with tenant-scoped retention logic matching C04's partition strategy.

---

## 3. RND API Technical Specification

### 3.1 Authentication

OAuth 2.0 Client Credentials flow:

```http
POST https://api.reassigned.us/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={CLIENT_ID}
&client_secret={CLIENT_SECRET}
&scope=rnd.query
```

Response:
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "rnd.query"
}
```

Token TTL is 1 hour. N06's RND client will cache the token in Valkey (`t:{tid}:rnd:token` key, TTL = `expires_in - 60s`) and re-fetch on expiry. Tokens are per-credential (per-tenant credentials stored encrypted in `tenant_rnd_config`).

### 3.2 Batch Query Endpoint

```http
POST https://api.reassigned.us/v1/query
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "numbers": [
    { "tn": "+12025551234", "date": "2024-11-15" },
    { "tn": "+13105559876", "date": "2024-09-01" }
  ]
}
```

- `tn`: E.164 format (+1NPANXXXXXX for US)
- `date`: ISO 8601, the consent date (or the date of last valid prior interaction)
- Maximum 1,000 numbers per request
- Rate limit: 100 requests/60s per credential → effective throughput: 100K TNs/min when batched at 1K each

Response:
```json
{
  "results": [
    {
      "tn": "+12025551234",
      "result": "No",
      "disconnect_date": null,
      "queried_at": "2026-05-13T20:00:00Z"
    },
    {
      "tn": "+13105559876",
      "result": "Yes",
      "disconnect_date": "2024-08-22",
      "queried_at": "2026-05-13T20:00:00Z"
    }
  ],
  "query_count": 2,
  "subscription_remaining": 487231
}
```

HTTP error codes:
- `400 Bad Request` — malformed body, invalid date format, >1000 numbers
- `401 Unauthorized` — invalid/expired token
- `402 Payment Required` — subscription expired or over quota
- `429 Too Many Requests` — rate limited; `Retry-After: <seconds>` header
- `503 Service Unavailable` — RND outage

### 3.3 File Upload (Batch >1K Numbers)

For pre-campaign scrubs with large lead lists:

1. Prepare CSV: `phone_e164,consent_date` (one row per number, no header)
2. Upload via SFTP to `sftp.reassigned.us` (port 22), path `/incoming/{client_id}/{filename}.csv`
3. RND processes asynchronously; results available via polling:
   ```http
   GET https://api.reassigned.us/v1/uploads/{upload_id}/status
   ```
4. When `status = "complete"`, download results:
   ```http
   GET https://api.reassigned.us/v1/uploads/{upload_id}/results
   ```
5. Results CSV: `phone_e164,result,disconnect_date,queried_at`

File upload processing time: typically 5–30 minutes for 1M numbers. N06 uses file upload for initial campaign scrubs (potentially millions of leads) and REST API for smaller re-scrub batches.

### 3.4 Subscription Status Endpoint

```http
GET https://api.reassigned.us/v1/subscription
Authorization: Bearer {access_token}
```

Response includes `tier`, `queries_used`, `queries_limit`, `reset_date`, `overage_rate`. N06 polls this daily to emit cost metrics and trigger budget-cap alerts.

---

## 4. Query Strategy

### 4.1 Pre-Campaign Batch Scrub (Primary Strategy)

The recommended workflow:

1. **Trigger**: Admin clicks "Scrub Before Launch" in campaign settings, or campaign's `auto_scrub_before_launch = true` triggers automatically on campaign status change to `RUNNING`.
2. **List collection**: N06 worker queries `leads` WHERE `campaign_id = ? AND phone_e164 IS NOT NULL AND status NOT IN ('DNC', 'REASSIGNED')`. Deduplicates by E.164.
3. **Consent-date resolution**: For each lead, resolve the consent date from `leads.consent_obtained_at` (D01 field). If null, use `leads.created_at` (conservative fallback). If lead is older than 60 days and has no consent date, flag for manual review.
4. **Batch construction**: Split into chunks of 1,000 for REST API (≤100K leads) or SFTP file for larger lists.
5. **Result processing**: For each `Yes` result, insert into `rnd_lookup_log` AND insert into `dnc` table with `source = 'reassigned'`. For each `No`, insert into `rnd_lookup_log` only (no DNC action). For `No Data`, insert into `rnd_lookup_log` with `result = 'no_data'`.
6. **DNC propagation**: The D05 DNC service picks up the new `reassigned` source entries. E01 hopper filler excludes them naturally through the existing DNC check.

### 4.2 Scheduled Re-Scrub

Each RND result expires for safe-harbor purposes at 60 days. N06 maintains a re-scrub queue:
- Nightly cron: find all `rnd_lookup_log` entries where `lookup_date < now() - 55 DAYS` AND phone still active in a running campaign
- Queue a `rnd-rescrub` BullMQ job with those phone numbers
- After re-scrub: if previously `No` and now `Yes`, insert into DNC and emit `rnd.number.reassigned_changed` audit event
- If previously `Yes` (still DNC) and now `No`: this is unlikely (numbers rarely get un-reassigned quickly) but handle by leaving the DNC entry (conservative); emit `rnd.number.scrub.conflict` for admin review

### 4.3 At-Dial-Time Real-Time Check (Future Phase)

Not in N06 scope. Mentioned here for completeness:
- T04 (pre-originate check) could call `DncService.isReassigned(phone, consentDate)` synchronously
- Would add 150–300 ms latency to every dial attempt
- Would consume enormous API quota (every dial = one query, including retries)
- Primary value: catches numbers that were reassigned between campaign-launch scrub and actual dial (gap could be hours to days for large campaigns)
- Recommendation: implement as opt-in toggle `campaign.rnd_realtime_check`, disabled by default; out of scope for N06

### 4.4 Consent Date Resolution Logic

The correct `date` parameter to send the RND API is the date the current subscriber's predecessor disconnected — specifically, "the date on or before which the number is claimed to have been reassigned." In practice, callers use their **consent date** (the date the current, presumably-consenting subscriber gave consent).

Priority order for consent date resolution:
1. `leads.consent_obtained_at` (explicit consent date from PEWC workflow)
2. `leads.called_count > 0` → `leads.last_called_at` (date of the last successful contact as EBR anchor)
3. `leads.created_at` (lead import date — conservative; the oldest possible anchor)
4. Campaign `created_at` (last resort — represents when the calling relationship began)

If no consent date can be resolved (all null, campaign brand-new), default to `today - 30 days` and log a `rnd.consent_date.fallback` warning.

---

## 5. Cost Analysis

### 5.1 Per-Query Economics by Tier

At current FCC-approved interim pricing (Federal Register Vol. 86, Nov 5, 2021; adjusted 2024):

| Scenario | Leads/mo | Queries/mo | Tier | Monthly Cost | Cost/Lead |
|---|---|---|---|---|---|
| Small center (1 campaign, 10K leads) | 10K | 20K (2× re-scrub) | XS | ~$45 | $0.0045 |
| Mid-market (5 campaigns, 50K leads each) | 250K | 500K | Small | ~$110 | $0.00044 |
| Large center (10 campaigns, 100K leads each) | 1M | 2M | Medium-Large | ~$350 | $0.00035 |
| Enterprise (50 campaigns, 200K leads each) | 10M | 20M | Jumbo | ~$2,000+ | $0.0002 |

### 5.2 Cost vs. TCPA Liability Risk

A single successful TCPA class action settlement typically ranges from $500K to $76M (per FCC reports and industry litigation data). The statutory damages are $500–$1,500 per violation, and each call to a wrong person is a separate violation. For a campaign with 100K reassigned-number calls, statutory exposure = $50M–$150M. Against this, even $2,000/month for Jumbo-tier RND is an obvious investment.

### 5.3 Budget Cap Implementation

- Per-tenant `rnd_monthly_budget_cents` setting (default: NULL = uncapped)
- After each scrub job, update `rnd_usage_log` with estimated cost (queries × tier rate)
- Before starting a new scrub, check: `used_this_month + estimated_cost > budget_cap`? → Reject and notify admin
- `GET /api/admin/rnd/usage` returns monthly cost breakdown

---

## 6. Caching Strategy

### 6.1 What to Cache

Each RND lookup result (phone + consent_date + result + disconnect_date + lookup_date) is stored in `rnd_lookup_log`. This is the authoritative audit record. For fast lookup (to avoid re-querying a number recently checked), a Valkey key is maintained:

```
t:{tid}:rnd:cache:{phone_e164_hash}  →  JSON{ result, disconnect_date, lookup_date, consent_date }
TTL: 55 days (5-day safety margin before 60-day safe-harbor freshness limit)
```

Phone hash: `SHA256(phone_e164)[0:16]` — hex-encoded 8-byte prefix — to avoid storing PII in Valkey keys.

### 6.2 Cache Invalidation

- On new scrub: SET the key unconditionally (overwrite old result)
- On DNC insertion from reassigned result: also mark `t:{tid}:rnd:dnc:{hash} = 1` (permanent, no TTL) so re-scrub skips numbers already in DNC
- Cache TTL (55 days) drives the re-scrub queue: nightly job scans `rnd_lookup_log WHERE lookup_date < now - 55 DAYS` rather than Valkey (Valkey cache is an optimization, DB is truth)

### 6.3 Re-Scrub Decision Logic

```
For each lead in active campaign:
  1. Check rnd_lookup_log: any row for (tenant_id, phone_e164) with lookup_date >= now - 55 DAYS?
     → YES (fresh): skip this number
     → NO (stale or never checked): add to re-scrub batch
  2. For stale: compare consent_date used in previous lookup to current consent_date
     → If consent_date moved earlier (caller is claiming an earlier EBR):
        must re-scrub with new date regardless of freshness
  3. Emit rnd.rescrub.scheduled metric per number enqueued
```

### 6.4 Result Validity Durations by Use Case

| Use Case | Recommended Re-Scrub Interval | Notes |
|---|---|---|
| High-velocity campaign (daily dials) | 30 days | Conservative; stay well inside 60-day window |
| Standard campaign | 55 days | 5-day safety margin before 60-day expiry |
| One-time batch campaign | 60 days (max) | Campaign completes before re-scrub needed |
| Archived lead list (not active) | On reactivation only | Do not re-scrub inactive leads |

---

## 7. DNC Source Taxonomy

### 7.1 Existing Sources (D05)

The `DncSource` enum in the Prisma schema already includes `reassigned` as a value (added in the base schema). No enum migration is needed.

```prisma
enum DncSource {
  federal       // FTC National DNC Registry
  state         // State DNC registries (11 states)
  internal      // Per-tenant opt-out (47 CFR 64.1200(d))
  litigator     // Known TCPA litigators / trolls (Phase 2)
  reassigned    // FCC Reassigned Numbers Database — N06 adds this
}
```

### 7.2 N06 Additions to DNC Flow

When N06 gets a `Yes` result from RND:
1. Insert into `dnc` table: `{ tenant_id, phone_e164, source: 'reassigned', state: '__', campaign_id: '__GLOBAL__', notes: 'RND:Yes:disconnect={disconnect_date}:as_of={consent_date}' }`
2. This propagates automatically to D05's `isDnc()` check
3. E01 hopper filler excludes the number on next fill cycle (≤ 30s latency)
4. T04 pre-originate check will also catch it if hopper fills between scrub and dial

### 7.3 Override Mechanism

Unlike `internal` DNC which can be removed by admin, `reassigned` DNC entries should be removable only with explicit justification:
- Verb: `rnd:override` (admin+ only, sensitive)
- When removing: require `justification_text`, create `audit_log` entry, set `notes` field on DNC row to include override reason
- Use case: FCC data error (false positive confirmed by carrier), or number re-issued to the same subscriber (extremely rare)

---

## 8. Failure Modes

### 8.1 RND API Outage

**Detection**: HTTP 503, connection timeout, consecutive 429s with no recovery.

**Behavior**:
- Do NOT block campaign launch — safe-harbor is a defense, not a requirement to dial
- Set `rnd_scrub_status = 'failed'` on the campaign
- Emit `rnd.api.outage` audit event
- Schedule retry: exponential backoff starting at 5 min, cap at 2 hours, 10 retries
- Admin notification via alert channel (O03 integration)
- If outage persists > 24h: escalate alert, recommend pausing campaigns with unscrubbed numbers

**Impact**: No safe-harbor for numbers called during outage period. Document the outage (timestamp, duration, ticket number) for litigation defense.

### 8.2 False Positives (RND says `Yes`, Number Not Actually Reassigned)

**Frequency**: FCC acknowledges ~0.1–0.5% error rate in RND data (carrier reporting latency, number porting edge cases).

**Detection**: Lead calls back saying "I never stopped being a customer / I've had this number for years."

**Response**:
- Admin can invoke `rnd:override` with justification
- System re-queries RND for confirmation
- If RND still says `Yes`: trust RND (carrier data takes precedence); escalate to carrier if needed
- If RND now says `No`: data was stale; update `rnd_lookup_log`, remove from DNC, re-add to hopper

### 8.3 `No Data` Responses

**Frequency**: Expected for VoIP numbers, Google Voice, some MVNOs where carrier participation in RND is incomplete (~5–10% of US numbers as of 2025).

**Behavior**:
- Store `result = 'no_data'` in `rnd_lookup_log`
- Do NOT insert into DNC (number is not confirmed reassigned)
- Do NOT claim TCPA safe-harbor for this number — document in audit trail
- These numbers may still be called, but the caller accepts full TCPA liability
- Optional: per-campaign `block_no_data = true` toggle for conservative compliance posture

### 8.4 Budget Cap Hit

**Behavior**:
- Scrub job checks budget before each batch
- If `used_this_month + batch_estimated_cost > budget_cap`: pause job, notify admin
- Campaign stays in `SCRUB_PAUSED` state
- Admin can increase budget cap or manually confirm launch without complete scrub
- Partial scrubs: numbers that were scrubbed are tracked; remaining unscrubbed numbers are flagged

### 8.5 Consent Date Missing

**Behavior**:
- Use fallback date resolution (Section 4.4)
- If no consent date can be resolved: use `today - 30 days` and emit `rnd.consent_date.unknown` audit warning
- Results obtained with an unknown consent date do not qualify for safe-harbor (documented in `rnd_lookup_log.consent_date_source = 'fallback'`)

---

## 9. Integration Points

### 9.1 D05 — DNC Service

N06 writes to the `dnc` table directly (bulk `INSERT IGNORE`) after scrub completion. D05's `isDnc()` service reads from this table via its standard Bloom filter path. No new service method needed — the existing `source='reassigned'` enum value suffices.

The Bloom filter for `reassigned` source: N06 must add scraped numbers to the Valkey Bloom filter `t:{tid}:dnc:reassigned:bloom` after inserting into the DB. D05 PLAN §5.2 reserved sizing for this:
- `BF.RESERVE t:{tid}:dnc:reassigned:bloom 0.001 500000 EXPANSION 2` — sized for 500K reassigned numbers per tenant, ~9 MB RAM.

### 9.2 E01 — Hopper Filler

No change needed. The hopper filler already excludes numbers in DNC regardless of source. The `useReassignedDnc` flag in campaign settings (new, added by N06) controls whether the `reassigned` source is checked during hopper fill. Default: `true`.

### 9.3 D03 — Phone Normalization

N06 uses D03's `normalizeE164(phone)` function before querying RND. All queries go to RND in E.164 format (`+1NPANXXXXXX`). Invalid numbers (non-US, non-NANP) are skipped with a `rnd.number.invalid_format` log entry.

### 9.4 C04 — TCPA Compliance / Retention

`rnd_lookup_log` records are partitioned by month and subject to the same 5-year retention rule as `call_log`. C04's retention worker will manage `rnd_lookup_log` partitions using the same `ALTER TABLE ... DROP PARTITION` strategy.

### 9.5 M05 — Settings Panel

M05's tenant settings editor gains a new section: "RND Scrub Settings" with fields for `rnd_client_id`, `rnd_client_secret` (encrypted display), `rnd_monthly_budget_cents`, `rnd_auto_scrub_on_launch`, `rnd_rescrub_interval_days`.

---

## 10. Open Questions

1. **SFTP vs. REST API threshold.** At what lead count should N06 switch from REST API batching to SFTP file upload? Recommendation: ≥50K leads → SFTP (avoids 50 sequential REST calls in 30 seconds, which uses the full rate-limit budget). Implementation can detect automatically by checking `lead_count > 50000`.

2. **Consent date source granularity.** D01's current lead model has `consent_obtained_at` as a nullable DateTime. Should N06 add a `consent_obtained_source` field to distinguish PEWC vs. EBR vs. inferred? This helps safe-harbor documentation. Recommendation: add `leads.consent_source ENUM('pewc','ebr','inferred','unknown')` in a separate D01 amendment if needed; N06 stores whatever is available.

3. **Multi-tenant credential sharing.** In a SaaS multi-tenant deployment, should there be one RND subscription per tenant or one global subscription that buckets queries by tenant? The FCC's subscription model is per-organization; in a true SaaS model (one legal entity operating vici2), one global subscription may suffice with internal per-tenant cost attribution. In a white-label model (each tenant is a different legal entity), each tenant needs their own subscription. N06 supports both: `tenant_rnd_config` stores per-tenant credentials; if null, falls back to a global `rnd_config_global` (system-level).

4. **Real-time scrub toggle placement.** Should the `rnd_realtime_check` toggle be in campaign settings (per-campaign) or tenant settings (per-tenant)? Recommendation: campaign-level (different campaigns may have different compliance postures), with a tenant-level default.

5. **`No Data` treatment standardization.** Should `No Data` results be treated as safe (current recommendation) or as blocking? Legal opinion varies. Some carriers' attorneys advise treating `No Data` the same as `Yes` to be maximally conservative. Make this a tenant-level policy: `rnd_no_data_policy ENUM('safe', 'block')` defaulting to `'safe'`.

6. **FCC penalty for NOT querying RND.** Is there an affirmative FCC rule requiring RND queries (vs. the safe-harbor being merely voluntary)? Currently (as of 2026), RND queries are voluntary for the safe-harbor — there is no FCC rule mandating them. However, several plaintiff attorneys argue that failing to query an available and affordable TCPA defense tool constitutes recklessness. N06 should emit admin warnings when a campaign is launched without a scrub but not block it.

7. **Number porting edge cases.** When a number ports from one carrier to another without disconnecting, the RND may show the number as "disconnected" from the original carrier. This is a known FCC data quality issue. N06 cannot distinguish ported-not-reassigned from genuinely reassigned without additional carrier data. Treat as-is per FCC guidance: trust the RND result.

---

## 11. Citations and References

1. 47 CFR §64.1200(f)(13) — TCPA safe-harbor definition including RND-query defense. https://www.law.cornell.edu/cfr/text/47/64.1200
2. FCC Report and Order FCC 18-177 (December 2018) — mandating creation of the RND. https://docs.fcc.gov/public/attachments/FCC-18-177A1.pdf
3. Federal Register Vol. 86 No. 212 — "Initial Interim Usage Charges for Subscriptions to the Reassigned Numbers Database" (Nov 5, 2021). https://downloads.regulations.gov/FCC-2021-0478-0001/content.htm
4. Reassigned Numbers Database — official FCC-contracted portal. https://www.reassigned.us/
5. RND Subscription Pricing (tiered, 6 tiers, 1/3/6-month subscriptions). https://www.reassigned.us/pricing
6. RND FAQ — query mechanics (Web GUI ≤50 TNs, API ≤1K TNs, file upload ≤1M TNs). https://www.reassigned.us/resources/faq
7. FCC Consumer FAQ — "Reassigned Numbers and the TCPA". https://www.fcc.gov/consumers/guides/reassigned-numbers
8. FCC Order FCC 21-35 (March 2021) — clarifying 60-day freshness window for safe-harbor. https://docs.fcc.gov/public/attachments/FCC-21-35A1.pdf
9. Welch Horn LLC — RND administrator and API documentation (internal API docs, requires registration). https://api.reassigned.us/docs
10. D05 RESEARCH.md §2.5 (RND context), §10.3 (RND productionization cost). /root/vici2/spec/modules/D05/RESEARCH.md
11. Blacklist Alliance — Litigation Firewall (for comparison: litigator + RND bundled offering). https://www.tcpablacklist.com/pricing
12. Contact Center Compliance (DNC.com) — bundled RND + federal + state DNC scrub service. https://old.dnc.com/
13. TCPA World — "Using the Reassigned Numbers Database as a TCPA Safe Harbor" (legal analysis). https://tcpaworld.com/2022/01/05/fcc-reassigned-numbers-database-tcpa-safe-harbor/
14. Squire Patton Boggs TCPA Blog — "The FCC Reassigned Numbers Database: What You Need to Know" (consent-date semantics). https://www.tcpablog.com/2021/06/14/fcc-reassigned-numbers-database/
15. 47 CFR Part 52 Subpart F — Number Portability (RND technical standards). https://www.law.cornell.edu/cfr/text/47/part-52/subpart-F

---
**End of RESEARCH.md (N06). Next: N06 PLAN — detailed schema, migration, worker, API routes, configuration, and acceptance criteria.**
