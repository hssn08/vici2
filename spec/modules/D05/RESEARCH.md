# Module D05 — DNC Management — RESEARCH

| Field | Value |
|---|---|
| Module | D05 (DNC scrub: Federal + State + Internal + Litigator) |
| Phase | 1 (Federal stub + Internal); Phase 2 (Litigator); Phase 4 (RND) |
| Compliance class | Hard floor (SPEC §4.1) |
| Status | RESEARCH |
| Date | 2026-05-06 |

---

## 1. Executive summary (10 bullets)

1. **Federal DNC is mandatory before every dial.** TSR / TCPA require a scrub against a copy of the federal Registry no older than 31 days; the FY2026 fee is **$82 per area code per year**, max **$22,626** for all 50 states (first 5 area codes free) [1][2]. The FTC publishes a SOAP web service `DownloadSvc.asmx` for automated daily Change-List downloads; payload formats are Flat Text File or XML [3][4][5].
2. **Internal (per-tenant, per-org) DNC is a separate FCC requirement** (47 CFR 64.1200(d)) — every seller must keep its own list of opt-outs, honor "stop calling me" within **10 business days**, and retain entries for **5 years** beyond the relationship [10]. This is the per-tenant `internal` source.
3. **Wireless numbers** have no separate federal Do-Not-Call list; the TCPA simply makes nearly all autodialed/prerecorded calls to wireless illegal absent prior express written consent [11]. The DNC table cannot be a substitute for the wireless-consent gate (handled by C01/D01); D05 only blocks numbers that **are** in a list.
4. **State DNC layering matters in 11 states**: CO, FL, IN, LA, MA, MO, OK, PA, TN, TX, WY each maintain a separately licensed list with its own update cadence, file format, and price (PA $595/yr quarterly, TN $500/yr monthly, IN $750/yr quarterly, FL $400/yr statewide annual, TX $200/qtr × 2 lists, etc.) [6][7][8][9][12]. PR1 ships with stubs; PR2 enables PA + TX + TN + IN + FL.
5. **Hot-path lookup must be < 10 ms (target p99 < 5 ms).** A 250-million-row federal table cannot be a `WHERE phone = ?` query under that budget at scale, so D05 uses a **Valkey Bloom filter as a negative fast-path** and falls back to MySQL only on positive hits [13][14][15].
6. **Recommended Bloom approach: `valkey-bloom` module** (BF.* commands, native Valkey 8 module) with `BF.RESERVE t:{tid}:dnc:bloom 0.001 300000000 EXPANSION 2` — sized for 300 M items at 0.1% FPR ≈ **540 MB RAM**, ~10 hash probes per check, O(1) per probe [13][14]. Falls back to in-process `bits-and-blooms/bloom` only if module unavailable.
7. **PK from F02 already encodes the four sources** as `(tenant_id, phone_e164, source, state, campaign_id)` with sentinel strings (`'__'`, `'__GLOBAL__'`) — D05 inherits this, no schema changes needed [F02 PLAN §4.14].
8. **Append-only with soft-delete** (`expires_at` future-dated, `deleted_at`-style audit trail) is required for FCC inspection; cleartext E.164 storage with strict RBAC is recommended over SHA-256 hashing because hashing makes lawful audit / bulk export impossible [10].
9. **Override: `dnc:bypass` permission** is highly restricted (super-admin-only, by-call, requires justification + audit_log entry). Real-world need: returning an inbound call after the customer dialed in (FCC explicitly allows). Outbound bypass is essentially never legal.
10. **Sync cadence:** federal Change-List nightly via SOAP + monthly full-list reconcile; state lists at vendor-specified cadence (TN monthly, IN/PA/FL/TX quarterly); litigator (Phase 2) on-demand pull; RND (Phase 4) per-call query (paid-per-query).

---

## 2. DNC source inventory

### 2.1 Federal (FTC National Do Not Call Registry)
- **Authority:** Telemarketing Sales Rule, 16 CFR 310.4(b)(1)(iii); TCPA 47 CFR 64.1200(c)(2) [10].
- **Size:** ~258 M active registrations (FY2025 Data Book) [16].
- **Refresh:** Telemarketer must scrub against a copy ≤ 31 days old. Industry practice: nightly delta + monthly full reconcile.
- **Access:** SAN (Subscription Account Number) issued after profile registration at https://telemarketing.donotcall.gov; first 5 area codes free; full national subscription FY2026 = $22,626/yr [1][2][4].
- **Formats:** Flat Text File (preferred — smaller), XML Tagged File. SOAP web service for automation: `https://telemarketing.donotcall.gov/DownloadSvc/DownloadSvc.asmx` (operations include `CanGetFullFile`, `GetFullFile`, `CanGetChangeFile`, `GetChangeFile`) [3][5].
- **Change List schema (Flat File):** fixed-width — phone (10 digits), date YYYY-MM-DD, action `A` or `D` [4][5].
- **Full List schema (Flat File):** one 10-digit number per line per area code [4].
- **Frequency limit:** one download per area code per day (`AlreadyDownloadedToday` is a documented response code) [3].
- **Exempt orgs:** charities/political get the full list free.

### 2.2 Internal (per-tenant)
- **Authority:** 47 CFR 64.1200(d) — *seller-specific* DNC; required even for sellers exempt from the federal list (e.g., charities, EBR-exempt) [10].
- **Trigger:** any agent disposition `DNC` / `DNCC`, any inbound "stop calling me" request, any web-form opt-out, any complaint.
- **Honor window:** 10 business days from request [10].
- **Retention:** 5 years from request (FCC); D05 is append-only, so old entries never disappear unless explicitly removed by admin (with audit_log entry).
- **Scope:** entire tenant (`source='internal'`, `state='__'`, `campaign_id='__GLOBAL__'`).
- **Campaign-scope variant:** `source='internal'`, `state='__'`, `campaign_id=<cid>` — for the "don't call me about solar but you can call me about insurance" pattern. Vicidial calls this `vicidial_campaign_dnc`; we collapse into the same table by varying `campaign_id` [17][18][19][20].

### 2.3 State DNC (11 still-active state registries)

Distilled from [6][7][8][9][12]:

| State | Cost (annual unless noted) | Cadence | Vendor / contact | Notes |
|---|---|---|---|---|
| **PA** | $595 | Quarterly | IMS Inc / OAG (ANA-administered) | 30-day removal window after each quarterly drop [9] |
| **TN** | $500 | **Monthly** | TPUC; password-protected cloud share | Highest cadence; toughest "Do Not Call/Text" combined statute [6] |
| **IN** | $750 | Quarterly | indonotcall.org (AG) | Telephone-Solicitor Registration also required separately [7] |
| **FL** | $30/AC quarterly or $400 statewide annually | Quarterly | FL DACS | 5-year auto-expiry on consumer-side; we honor `expires_at` |
| **TX** | $200/qtr DNC + $200/qtr Electric No Call | Quarterly | Gryphon Networks Corp / texasnocall.com | Two separate lists (residential/wireless vs. business-electric) [8] |
| **CO** | $50/AC, $500 statewide | Quarterly | CO PUC | — |
| **LA** | $800–$1,700 sliding | Quarterly | LA PSC | — |
| **MA** | $1,100 + $60 CD | Quarterly | MA OCA | — |
| **MO** | $50/AC; ~$1,500 statewide | Quarterly | MO AG | — |
| **OK** | $50–$150/qtr | Quarterly | OK AG | — |
| **WY** | $150/qtr | Quarterly | WY AG | — |

For a typical multi-state US dialer: PR1 stubs all 11; PR2 productionizes the top-5 (PA, TX, TN, IN, FL) which cover ~95% of US litigation risk per Blacklist Alliance/Gryphon reports.

### 2.4 Litigator suppression (Phase 2)
- **TCPA Litigator List** (`tcpalitigatorlist.com`) — known-litigator + "TCPA troll" + repeat-plaintiff database. API plans $99–$8,999/mo; pay-as-you-go from $0.001/scrub [21][22].
- **Blacklist Alliance** — "Litigation Firewall" real-time API; plans $99–$999/mo plus enterprise; SAN-relay for federal DNC; subscription-based federal record retention (5 yr) [23][24].
- **Contact Center Compliance (DNC.com)** — bundled federal + state + litigator + RND; quote-only.
- All three expose REST or SOAP APIs returning `{ litigator: bool, score: 0–100, source: 'troll'|'attorney'|'plaintiff' }` per number.
- We treat litigator as `source='litigator'`, `state='__'`, `campaign_id='__GLOBAL__'`. Phase 2: nightly pull of the vendor's *delta* (not per-call query — too costly at our volumes).

### 2.5 Reassigned Numbers Database (Phase 4)
- **FCC RND** — reassigned.us, paid per query, 6 subscription tiers from XS to Jumbo, one-month / three-month / six-month subscriptions [25][26][27].
- Returns `Yes / No / No Data` for "was this number permanently disconnected on or before {consent_date}".
- Pay-per-query → cannot be in hot path; Phase 4 will be a *per-lead, on-import* enrichment + per-callback re-check.
- Not stored in `dnc` table (it's a service, not a list); but a positive RND result causes the lead to be added with `source='internal'`, `notes='RND-reassigned'`.

---

## 3. Federal DNC SAN access process

### 3.1 Account setup (one-time)
1. Designate Authorized Representative; create profile at https://telemarketing.donotcall.gov [4].
2. Identify org as Seller / TM-SP / Service Provider / Exempt.
3. Subscribe to area codes (first 5 free; pay for the remainder; full national = $22,626 in FY2026) [1][2].
4. Pay (CC immediate; ACH waits 3 business days).
5. SAN issued; SAN + Org ID + Representative password used for downloads.

### 3.2 Daily delta sync (Change List)
Recommended daily 02:00 UTC cron (off-peak DNC website hours):

1. POST `CanGetChangeFile(strSessionToken, strCoID)` → returns one of:
   - `RequestPending` / `RequestCompleted` — wait/proceed
   - `NoChanges` / `NoFullDownloadPerformed` — skip
   - `AlreadyDownloadedToday` — skip
   - `LoginOK`, etc.
2. POST `GetChangeFile(strSessionToken, strCoID, format='FlatText'|'XML', areaCode='ALL'|'212'|...)`.
3. Server returns presigned URL; download `.zip` (5 min on a good link, ~5–500 MB depending on AC count) [5][28].
4. Unzip; parse fixed-width:
   ```
   <10-digit phone> <YYYY-MM-DD> <A|D>
   ```
5. Idempotently upsert into `dnc` (`source='federal', tenant_id=0` as global / shared row — see Open Questions) and into Bloom filter.
6. Record `last_sync_at`, `added`, `removed` counts in `dnc_sync_log` (new table — see PLAN).

### 3.3 Monthly full reconcile
First Sunday of each month: `GetFullFile` → drop-and-rebuild federal partition + rebuild Bloom from MySQL (`BF.RESERVE` + `BF.MADD` chunk-batched). Catches any missed-delta cases.

### 3.4 Auth notes
- Session token expires; must `LogIn` before each batch.
- Single concurrent session per SAN — must serialize across worker pods (use Valkey lock `t:0:dnc:fed:sync:lock` 60 min TTL).
- Response codes are documented in the WSDL fragment from [3]: `LoginOK / LoginFailed / LoginDisabled / SubmitOK / SubmitFailed / InvalidSessionToken / InvalidCompanyID / InvalidFileReqToken / InvalidRequest / RequestPending / RequestCompleted / NoChanges / NoFullDownloadPerformed / SessionExpired / DownloadOK / AlreadyDownloadedToday / CertificationNotAgreed / FileNotValidForDownload / DownloadFailed`.

---

## 4. Lookup architecture (MySQL truth + Valkey Bloom)

### 4.1 Decision tree per `isDnc(phone, opts)` call

```
1. normalize(phone) → E.164 (+1NPANXXXXXX)            # < 100 ns (in-process)
2. for each enabled source in [internal, state, federal, litigator]:
     a. BF.EXISTS t:{tid}:dnc:{source}:bloom phone     # ~150 µs over UDS
     b. if bloom says "definitely-not": continue
     c. if bloom says "maybe":
          MySQL SELECT 1 FROM dnc WHERE PK matches      # 0.5–2 ms (covering index)
          if hit → record source, continue
          if miss → record false-positive metric
3. return { dnc: sources.length>0, sources }
```

p99 budget: 4 sources × (0.15 ms BF + 0.5% × 1.5 ms MySQL) ≈ **0.65 ms hot, 1.2 ms with one FP**. Comfortably under the 10 ms hard cap and even the 5 ms soft target.

### 4.2 Why Bloom + MySQL, not Redis SET / cache-per-key
- `t:{tid}:dnc:internal` as a Valkey SET works at hundreds of thousands of entries (DESIGN.md / F04 §4.11 negative cache). Falls over for federal (250 M numbers × ~18 B per `SADD` → ~4.5 GB just for federal, per tenant if tenanted) [F04 PLAN §4.12].
- Cache-per-phone STRING (`cache:dnc:{tid}:{phone}` TTL 1h) only covers numbers we've already looked up; cold-call lists devastate the cache hit rate.
- Bloom filter is **the** purpose-built primitive for this exact pattern (huge static set, hot membership-test, false-positive tolerance, no false-negative tolerance). Industry consensus: AWS ElastiCache reference architecture for "lookups against large blocklists" is exactly this pattern [29].

### 4.3 MySQL row source-of-truth (covering index)
F02 PLAN §4.14 already gives us:
- PK `(tenant_id, phone_e164, source, state, campaign_id)` — perfect for the post-Bloom confirm query.
- `INDEX idx_phone_only (phone_e164)` — used by federal scrub (federal rows live with `tenant_id=0` sentinel).
- `INDEX idx_t_source_added (tenant_id, source, added_at)` — sync reports.

We use `EXPLAIN`-verified covering reads only; no `SELECT *`.

### 4.4 Fallback when valkey-bloom module is unavailable
If a given Valkey deployment doesn't load `valkey-bloom` (e.g. local dev with stock Valkey), D05 falls back to **in-process** `github.com/bits-and-blooms/bloom/v3` per dialer-engine pod, populated on boot from MySQL via streaming reads. Costs ~540 MB RAM per pod and adds a startup time ~30–60 s for federal — acceptable for dev, not great for prod, hence module preferred.

---

## 5. Bloom filter sizing

### 5.1 Math (RedisBloom / valkey-bloom shared formulas) [13][14][15]

Bits per item: `m/n = -ln(p) / (ln 2)²`
Hash functions: `k = -log₂(p)`

| FPR `p` | bits/item | hashes `k` | memory for 300 M items |
|---|---|---|---|
| 1% | 9.59 | 7 | ~360 MB |
| 0.1% (recommended) | 14.38 | 10 | **~540 MB** |
| 0.01% | 19.17 | 14 | ~720 MB |

### 5.2 Recommended sizing

```
# Federal (shared across tenants — global)
BF.RESERVE bf:dnc:federal 0.001 300000000 EXPANSION 2

# Per-tenant internal (typical SMB ≤ 100 K opt-outs)
BF.RESERVE t:{tid}:dnc:internal:bloom 0.001 200000 EXPANSION 2

# Per-tenant state combined (ceiling ~5 M for biggest aggregator)
BF.RESERVE t:{tid}:dnc:state:bloom 0.001 5000000 EXPANSION 2

# Litigator (Phase 2; ~5–10 M known)
BF.RESERVE bf:dnc:litigator 0.001 10000000 EXPANSION 2
```

Total Valkey RAM at full saturation per node: ~600 MB federal + ~20 MB litigator + ~10 MB/tenant × tenants. Fits comfortably inside the F04 10 GB Valkey budget.

### 5.3 Why EXPANSION 2, not NONSCALING
NONSCALING is faster on EXISTS (single-vector probe) but errors on `BF.ADD` past capacity; with daily federal additions we'd be one bad sync from a hard failure. EXPANSION 2 chains a doubled sub-filter per overflow at the cost of O(k·subfilter_count) on EXISTS; with 30% headroom in the initial reserve, sub-filters are rarely created.

### 5.4 Backup / persistence
Valkey AOF/RDB persists Bloom modules. For disaster recovery, also do nightly `BF.SCANDUMP → S3` per-source so we can rebuild without re-walking MySQL [15]. After a reboot if Bloom is gone, the dialer engine refuses to dial (fails closed — the compliance hard-floor invariant).

---

## 6. Bulk import API

### 6.1 Endpoint
```
POST /api/admin/dnc/bulk
Content-Type: multipart/form-data
form-fields:
  source: 'internal' | 'state' | 'litigator'
  state:  CHAR(2) (required if source='state')
  campaign_id: VARCHAR(32) optional (else __GLOBAL__)
  file:   <CSV>
  notes:  string (audit annotation)
```

### 6.2 CSV shape
```
phone_e164,added_at,expires_at,note
+12125551234,2026-05-01,,Customer opt-out via web form
+13105550000,2026-05-01,2031-05-01,5y FCC retention horizon
```

### 6.3 Pipeline (workers/src/jobs/dnc-bulk-import)
1. Stream-parse with `csv-parse` (Node) — chunk = 5 000 rows.
2. Normalize each row (libphonenumber-js → E.164; reject bad).
3. Within a transaction: `INSERT IGNORE INTO dnc (...) VALUES (...)` (10 K-row VALUES list).
4. After commit, batched `BF.MADD` against the source's Bloom filter.
5. Audit_log entry per chunk + summary row in `dnc_sync_log`.

Target throughput: 10 K rows/s on a 4-core dialer (matches Vicidial's `LOAD DATA LOCAL INFILE` approach [17] but normalized + audit-friendly).

### 6.4 Federal bulk import (one-time bootstrap, not the API)
- 250 M rows over MySQL `LOAD DATA INFILE` ~10 min on a warm InnoDB instance with `unique_checks=0, foreign_key_checks=0` during load.
- Bloom build: stream `phone_e164` from MySQL → `BF.MADD` 100 K at a time → ~5 min wall time.

---

## 7. Audit + override controls

### 7.1 audit_log entries D05 emits (referencing F02 §4.6)
- `dnc.add` — `entity_type='dnc'`, `entity_id=PK-hash`, `data={phone, source, campaign_id, state, notes}`
- `dnc.remove` — soft-delete with reason field
- `dnc.bulk_import` — `data={source, count_added, count_rejected, file_hash, justification}`
- `dnc.bypass.attempt` — every call to bypass DNC, even if denied
- `dnc.bypass.granted` — when an authorized super-admin grants a one-time bypass
- `dnc.sync.federal` / `dnc.sync.state` — `data={source, added, deleted, last_sync_at, file_url}`

### 7.2 Override permission (`dnc:bypass`)
- Permission gated by RBAC (F05) at role `superadmin` only.
- API: `POST /api/admin/dnc/bypass-token` with body `{ phone, source, expires_at_max=now+60s, justification }` → returns short-lived token used by T04 to skip the D05 check on a single call.
- T04 verifies token with single-use redemption (Valkey `SET NX EX 60`).
- Every bypass writes a chained audit entry with `prev_hash` (C03 hash chain).
- Allowed legal pattern: returning an inbound from a DNC-listed customer (FCC explicitly permits — they called us first). Outbound bypass is essentially never legal and the UI shows a red banner saying so.

### 7.3 Cross-tenant DNC (super-admin "global block")
- Stored as `tenant_id=0` rows. Hot-path scrub does **two** Bloom checks: tenant-specific + global. Used for known scammer numbers, court-ordered blocks, etc. ~1 % FPR overhead added.

### 7.4 Privacy: cleartext vs hashed phone storage
- We store **cleartext E.164** in `dnc.phone_e164`. Rationale:
  - FCC inspection / TCPA-defense package demands the actual number, not a hash.
  - Bulk export to a regulator must be readable.
  - Confidentiality enforced via row-level RBAC + at-rest disk encryption.
- SHA-256 storage was considered but rejected — false-positive collision risk is irrelevant against the loss of audit utility.

---

## 8. Per-dial check vs nightly revalidation

### 8.1 Per-dial check (mandatory; T04 calls this)
Every dial attempt runs `isDnc()` immediately before `bgapi originate`. This is the regulatory hard-floor (SPEC §4.1). If the lead was loaded into the hopper at T-2h but a DNC sync at T-30min added the number, the per-dial check still catches it. Cost: ~0.7 ms p99 (Section 4.1).

### 8.2 Nightly revalidation
Worker `dnc-revalidate-nightly` walks the day's `vicidial_hopper` (E01) and removes / marks any lead newly DNC since hopper-fill. Defense-in-depth — catches rows already in hopper that became DNC mid-day. Also re-scrubs all "live"-status leads and toggles `leads.dnc=true` for reporting.

### 8.3 Hopper-load check (E01 will call us)
Cheap enough to run during hopper fill too — eliminates obvious DNC numbers before they enter the hopper. This is the layer Vicidial relies on; we keep it but **do not** treat it as the regulatory check (only the per-dial check counts for compliance).

---

## 9. State DNC layering

### 9.1 Resolution rule
For phone with derived state `S` (from `leads.state` or area-code timezone via D03), at scrub time:
1. Always check `internal` (tenant's own list).
2. Always check `federal` (national list).
3. Check `state` rows where `state IN (S, '__')` — `'__'` allows for cross-state state-DNC entries (rare).
4. Optionally check `litigator` (Phase 2).

Bloom keys are scoped per source; **state-specific** bloom is single per tenant (not per `S`) for memory efficiency — false positive only forces the MySQL confirm to filter by `state=S`.

### 9.2 State-DNC override of federal exemption
Federal TSR exempts (a) prior consent, (b) charity, (c) political, (d) EBR. **State laws often do not** — particularly PA and TX, which have no EBR exemption for residential. Therefore:
- Every campaign has independent boolean toggles (already in F02 §4.something): `use_federal_dnc`, `use_state_dnc`, `use_internal_dnc`, plus `respect_ebr_for_federal` (default true, but does not affect state).
- Audit_log entry `campaign.update` records changes.

### 9.3 Per-state special cases (informational; for PLAN)
- **TX dual-list:** `dnc.state='TX'` may carry sub-source via `notes='TX-electric'` or via `campaign_id` if the call is electric-related. PR2 will introduce a `subsource` column or use `notes`-prefix encoding.
- **TN monthly cadence:** worker schedule is monthly first-Sunday for TN, quarterly first-Sunday-of-Jan/Apr/Jul/Oct for the rest.
- **FL 5-year expiry:** rows include `expires_at = added_at + 5y`; nightly worker removes expired rows from MySQL and rebuilds the FL portion of the state Bloom.

---

## 10. Open questions for PLAN

1. **Federal-DNC tenancy model.** Is the federal copy stored as `tenant_id=0` (one global copy, all tenants share the Bloom) — yes (saves 540 MB × N_tenants RAM). Confirm with F02 owner; PK includes tenant_id so this requires a sentinel tenant row.
2. **State copy tenancy.** Same question — share state lists across tenants? Probably yes (lists are public-license). Same `tenant_id=0` pattern.
3. **FCC RND productionization.** Phase 4 — pay-per-query economics: at 100 K dials/day × $0.05/query (Jumbo tier) = $5K/day. Need a separate consent-tracking table so we only RND-check leads whose consent date is older than the contact-attempt date.
4. **Litigator vendor selection.** TCPA Litigator List vs Blacklist Alliance vs CCC — the differentiator is the size of the troll list and the API SLA. Recommend Blacklist Alliance (proprietary "Litigation Firewall" + bundled state DNC + bundled federal SAN management) for vendor consolidation; pricing TBD.
5. **Audit-log data field for federal sync.** Federal sync drops/adds millions per day; do we write one audit_log per row (audit_log explodes) or one summary row? Recommend one summary row per source per day, with the file_hash and counts.
6. **Bloom rebuild on tenancy delete.** When a tenant is deleted (Phase 4 multi-tenant), do we `BF.DEL t:{tid}:*:bloom` and rely on key-pattern scan? Yes; cheap.
7. **Inbound DNC bypass UX.** When an inbound caller is on the DNC list, do we (a) auto-bypass and just record it, or (b) require agent click "Yes, returning their call"? Recommend (b) for litigation defense.
8. **`dnc:internal` retention beyond 5 yr.** FCC requires 5-year retention; many sellers want longer. Make it a tenant-level setting `internal_dnc_retention_years` (default 5, max 99).
9. **Dnc-source priority in audit.** When multiple sources match, which one is "the" reason? Preference order: `internal > state > federal > litigator` (most specific to least).
10. **Bloom-filter false-positive metric.** Need a Prometheus counter `vici2_dnc_bloom_fp_total{source}` and alert when ratio exceeds 2× the configured FPR (0.002) for 1 hour — indicates Bloom degraded.

---

## 11. Citations

1. FTC press release — "Telemarketer Fees to Access the FTC's National Do Not Call Registry to Increase in 2026" (Aug 27, 2025). https://www.ftc.gov/news-events/news/press-releases/2025/08/telemarketer-fees-access-ftcs-national-do-not-call-registry-increase-2026
2. National Law Review — "FTC Announces Increase to Telemarketer Fees to Access National Do Not Call Registry" (Aug 27, 2025). https://natlawreview.com/article/ftc-announces-increase-telemarketer-fees-access-national-do-not-call-registry
3. FTC DownloadSvc Web Service WSDL — `CanGetFullFile`, `CanGetChangeFile` SOAP endpoints. https://telemarketing.donotcall.gov/DownloadSvc/DownloadSvc.asmx?op=CanGetFullFile
4. FTC — "Q&A for Telemarketers & Sellers About DNC Provisions in TSR" (registry access, Flat-File / XML formats, SAN onboarding). https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0
5. CallNot vendor guide describing FTC delta-download URL format and email-link delivery. http://cicorp.com/software/callnot/help/2DownloadFTC/index.htm
6. Tennessee Public Utility Commission — "TN Do Not Call/Text Telemarketer FAQs" ($500/yr, monthly cloud-share update). https://www.tn.gov/tpuc/tennessee-do-not-call-program/csd-tn-do-not-call-telemarketer-faqs.html
7. Indiana Attorney General — Telephone Solicitor / Do Not Call list ($750/yr quarterly download). https://www.in.gov/attorneygeneral/consumer-protection-division/id-theft-prevention/do-not-call/telephone-solicitors
8. Texas PUC — "Texas No-Call List" ($200/qtr each list; Statewide DNC + Electric No Call). https://www.texasnocall.com/subscriberFAQ_TX.asp ; rule https://www.law.cornell.edu/regulations/texas/16-Tex-Admin-Code-SS-26-37
9. Pennsylvania OAG — Do Not Call program; IMS distribution at $595/yr quarterly. https://www.attorneygeneral.gov/protect-yourself/do-not-call-list/ ; https://ims-dm.com/mvc/page/pennsylvania-do-not-call-list
10. 47 CFR § 64.1200 (TCPA delivery restrictions; internal DNC, EBR, 10-business-day, 5-year retention). https://www.law.cornell.edu/cfr/text/47/64.1200
11. FCC — "Wireless Phones and the National Do-Not-Call List". https://www.fcc.gov/consumers/guides/wireless-phones-and-national-do-not-call-list
12. DNC.com — "The 11 States with State-Level DNC Lists" (cost / cadence / vendor table). https://old.dnc.com/news/11-states-state-level-dnc-lists
13. Redis — Bloom filter docs (`BF.RESERVE`, sizing formulas, EXPANSION). https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/
14. Valkey blog — "Introducing Bloom Filters for Valkey" (`valkey-bloom` module, 128 MB default cap, BF.* commands). https://valkey.io/blog/introducing-bloom-filters/
15. RedisBloom Bloom Commands reference (BF.SCANDUMP / BF.LOADCHUNK for backup). https://oss.redislabs.com/redisbloom/Bloom_Commands/
16. FTC — National Do Not Call Registry Data Book FY2025 (~258 M registrations). http://www.ftc.gov/reports/national-do-not-call-registry-data-book-fiscal-year-2025
17. ViciStack — "VICIdial DNC List Management: Federal, State & Internal" (vicidial_dnc + vicidial_campaign_dnc patterns, LOAD DATA INFILE). https://vicistack.com/blog/vicidial-dnc-management/
18. ViciStack glossary — DNC in VICIdial (system-wide vs campaign DNC). https://vicistack.com/glossary/dnc/
19. goautodial/goAPIv2 — `goActionDNC.php` (insert into vicidial_dnc with audit). https://github.com/goautodial/goAPIv2/blob/master/goLists/goActionDNC.php
20. goautodial/goAPIv2 — `goUpdateDispo.php` (DNC disposition triggers `INSERT IGNORE` into vicidial_dnc + vicidial_campaign_dnc, supports area-code wildcards `XXXXXXX`). https://github.com/goautodial/goAPIv2/blob/master/goAgent/goUpdateDispo.php
21. TCPA Litigator List — API Gold ($499/mo, 500K scrubs included, $0.001/scrub thereafter). https://tcpalitigatorlist.com/shop/api-gold/
22. TCPA Litigator List — Packages (Silver $299 → Diamond $8,999/mo). https://tcpalitigatorlist.com/packages/
23. Blacklist Alliance — Pricing ($99–$999/mo, pay-as-you-go $0.05/check, Litigation Firewall API). https://www.tcpablacklist.com/pricing
24. Blacklist Alliance — Yearly Subscription Terms (SAN-relay model, 5-yr DNC scrub retention, 30-day non-DNC retention). https://www.blacklistalliance.com/subscription-term/yearly-subscription-terms
25. Reassigned Numbers Database — Subscription Pricing (interim tiered, 6 tiers, 1/3/6-month subscriptions). https://www.reassigned.us/pricing
26. RND FAQ — query mechanics (Web GUI ≤50 TNs, API ≤1 K TNs, file upload ≤1 M TNs). https://www.reassigned.us/resources/faq
27. Federal Register Vol. 86 No. 212 — "Initial Interim Usage Charges for Subscriptions to the Reassigned Numbers Database" (Nov 5, 2021). https://downloads.regulations.gov/FCC-2021-0478-0001/content.htm
28. FTC Q&A re Change List daily delta delivered as compressed file via signed email link (also accessible via SOAP). https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0
29. AWS blog — "Implement fast, space-efficient lookups using Bloom filters in Amazon ElastiCache" (blocklist reference architecture mirrors our DNC use case). https://aws.amazon.com/blogs/database/implement-fast-space-efficient-lookups-using-bloom-filters-in-amazon-elasticache/
30. Vicidial forum — internal vs campaign DNC behavior, "Add Number To DNC" flow. https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=7252

---
**End of RESEARCH.md (D05). Next: D05 PLAN — write FTC SOAP client wrapper, Bloom-filter abstraction with valkey-bloom + bits-and-blooms fallback, dnc_sync_log schema, audit_log mappings, override-token spec.**
