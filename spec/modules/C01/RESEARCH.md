# C01 — Time-Zone Enforcement Gate — RESEARCH

**Module:** C01 (TCPA hard floor: never dial called party between local 9pm and 8am)
**Status:** RESEARCH (blocked on F02 schema and D03 timezone resolver)
**Date:** 2026-05-06
**Working scope:** US dialing only (NANP). Canada / international calls out of scope for Phase 1.

> **Stakes.** $500 statutory damages per illegal call, $1,500 per willful call (47 U.S.C. § 227(b)(3)). Violations are aggressively litigated as class actions — over 100 "quiet hours" class actions filed in Q1 2025 alone (see §11). This module is **the** technical control that prevents that exposure for vici2 operators.

---

## 1. Executive summary (10 bullets)

1. **Federal floor:** 47 CFR § 64.1200(c)(1) prohibits any "telephone solicitation" to a residential subscriber before 8:00am or after 9:00pm **at the called party's location**. The window is the called party's time, never the caller's.
2. **State floor wins when stricter.** 18 states impose narrower windows than federal. The gate must compute `intersection(federal_window, state_window, campaign_window)` per call.
3. **Strictest states for orchestrator awareness:** Rhode Island (Mon–Fri 9am–6pm only), Kentucky (10am start — latest in the country), Texas (Sun noon–9pm), Pennsylvania (Sun 12pm–9pm), Maine (automated calls 9am–5pm only), and Alabama / Louisiana / Mississippi / Utah / (effectively Sunday-prohibited states).
4. **Holiday and Sunday gates** are real and underestimated: Alabama, Louisiana, Mississippi, Utah and Rhode Island prohibit telemarketing on Sundays; Alabama, Louisiana, Rhode Island, Utah prohibit on legal holidays. Louisiana includes Mardi Gras and Good Friday.
5. **Identifying called-party local time is hard.** Number portability means NPA-NXX → tz can be wrong. Industry-standard mitigation is a 4-tier fallback: `lead.known_timezone` → `lead.zip` → `phone.NPA-NXX` → `campaign.default` → BLOCK.
6. **Indiana is split:** 12 counties in NW/SW are Central; rest of state is Eastern. Within several Indiana NPAs (219, 574, 765, 812) some NXX prefixes are CT and others ET. Lookup must be NXX-granular for Indiana, not NPA-only. (libphonenumber's PhoneNumberToTimeZonesMapper mostly does NPA-only — this is a **gap** we must close with a supplemental dataset.)
7. **DST must be handled via IANA tz names** (e.g., `America/New_York`), not fixed offsets. Go's `time.LoadLocation` and Postgres `AT TIME ZONE` do this correctly. Storing fixed `gmt_offset` is the bug Vicidial inherited; we must avoid it.
8. **Three enforcement points** (defense in depth): (a) hopper filler (E01) — skip leads outside window, recompute eligibility timestamp; (b) originate path (T04) — final pre-bgapi gate; (c) pacing loop (E02) — deprioritize/abort leads where window closes within ~30s to avoid abandons-after-close.
9. **Audit log per blocked attempt.** Every BLOCK or SKIP must immutably record: tz inputs (lead state, zip, phone, known_tz), tz computation result, now-in-tz, applicable window, and rule that fired (federal vs state). This is the FCC complaint defense package; links to C03 audit immutability.
10. **B2B exemption is narrow and dangerous.** FTC's TSR exempts most B2B from federal DNC, but FCC's TCPA (47 CFR § 64.1200) treats B2B autodialed calls to wireless the same as B2C. **Recommendation:** the gate runs the same regardless of B2B flag in Phase 1; revisit only after legal review.

### State rules stricter than federal — orchestrator MUST be aware

| Tier | States | Why orchestrator cares |
|---|---|---|
| **Sunday-blackout** | AL, LA, MS, UT, RI | Hopper must skip Sunday entirely for these state-leads |
| **Holiday-blackout** | AL, LA, RI, UT (and Mardi Gras / Good Friday in LA) | Need a state-holiday calendar table; F02 schema must include `state_holidays` |
| **8pm cutoff** (vs federal 9pm) | AL, CT, FL, KY, LA, MD, MA, MS, OK, RI, WA, WY | One hour of revenue lost — campaign settings UI must surface this |
| **Late start** (vs federal 8am) | CT (9am), MI (9am), MN (9am), KY (10am), TX (9am Mon-Sat / noon Sun), PA (8am M-Sa / noon Sun) | Hopper filler must compute earliest-eligible-time per lead-state |
| **Maine special** | ME — automated calls only allowed 9am–5pm M-F, no weekends | If campaign uses prerecorded/AMD, ME leads need separate window |
| **Florida frequency cap** | FL | 3 calls per consumer per 24h on same subject (§501.616) — pace counter, not just window |
| **Oklahoma frequency cap** | OK | 3 calls per consumer per 24h on same subject (15 OS § 775C.4) |
| **Maryland frequency cap** | MD | 3 calls per 24h (Md. Com. Law 14-3201) |

(Frequency caps are out-of-scope for C01 itself but flagged so D04/D06/E01 know to track per-lead daily call counts.)

---

## 2. Federal TCPA rules summary

### 2.1 Authority
- **Statute:** Telephone Consumer Protection Act, 47 U.S.C. § 227.
- **Implementing rule:** 47 CFR § 64.1200 (FCC). Mirror at FTC: 16 CFR § 310 (Telemarketing Sales Rule).
- **Statutory damages:** $500/call, trebled to $1,500 for willful or knowing violation. Class-actionable; no cap.

### 2.2 Calling hours rule (47 CFR § 64.1200(c)(1))

> "No person or entity shall initiate any telephone solicitation to … a residential telephone subscriber before the hour of 8 a.m. or after 9 p.m. (local time at the called party's location)."

Key interpretive points (from 2025 case law and FCC orders):
- **"Local time at the called party's location"** — caller's burden to determine. Plain reading.
- **Boundaries:** at exactly 8:00:00, calls are permitted; at exactly 9:00:00, calls must have already stopped (best-practice: stop *initiating* at 8:59:30 to ensure no in-flight call rings after 9:00).
- **Applies to "telephone solicitation"** — defined in (f)(15) as "the initiation of a telephone call or message for the purpose of encouraging the purchase or rental of, or investment in, property, goods, or services." Excludes calls to (i) people with prior express invitation/permission, (ii) people with established business relationship, (iii) tax-exempt nonprofits.
- **Quiet-hours wave 2025:** Bernal v. Mixtiles (D.S.D.N.Y. 2025) and 100+ similar class-actions allege quiet-hour violations apply even with consent for autodialed text/voice. EIA petition to FCC (March 3, 2025) seeks to clarify that consent moots quiet-hours; **not yet resolved**. Conservative reading: gate runs regardless of consent.

### 2.3 Definitions used by the gate (47 CFR § 64.1200(f))
- **"Telephone solicitation"** — the call we are gating. (Informational/transactional calls are technically exempt from the time-of-day rule but defining a call as "informational" is risky; the gate runs on all outbound by default.)
- **"Established business relationship" (EBR)** — purchase or transaction within prior 18 months. Even with EBR, time-window applies (the EBR exception is for the DNC scrub, not the time gate).
- **"Prior express written consent"** — written agreement, signed, identified phone number, clear seller, not condition of purchase. Per FCC 2024 lead-generator order (effective Jan 27, 2025), one seller per consent. Even with PEWC, time-window may still apply (litigation pending).

### 2.4 Recent FCC orders (2023–2026)
- **FCC 23-107 (Dec 2023, effective Jan 27, 2025) — "Lead Generator Order":** closes lead-generator loophole. Each "comparison shopping" lead now requires one-to-one consent per seller. (Affects D05 DNC and consent capture, not C01 directly, but informs the audit-log schema — we record the consent record id at dial time.)
- **FCC 24-24 (Feb 2024, partial effect April 11, 2025; § 64.1200(a)(10) "reasonable methods" extended to **April 11, 2026**, then to **January 31, 2027**):** revocation-of-consent rule. A revocation request honored within reasonable time (now codified as 10 business days max).
- **DA-26-12 (Jan 2026):** further extensions and clarifications (under review by industry).
- **March 2025 EIA Petition:** requests clarification that quiet-hours rule does not apply when prior consent given. **No resolution as of May 2026.** Conservative posture: assume quiet-hours apply regardless of consent.
- **STIR/SHAKEN expansions (2023–24):** outbound CallerID attestation. Not in C01 scope but informs T02 carrier config.

### 2.5 Drop-rate (TSR safe-harbor) — separate from time-window
- **3% rolling 30-day cap** on abandoned (dropped) calls per campaign (16 CFR § 310.4(b)(4)). Not enforced by C01 — that's E05. But C01's "approaching boundary" logic interacts: abandoning a call at 8:59pm by stopping origination is preferable to bridging at 9:01pm.

---

## 3. State exceptions matrix (stricter than federal floor)

> Sources: state statutes, AG advisories, and 2026 industry compilations. Verify with counsel before launch — laws change frequently.

| State | M-F | Sat | Sun | Holiday | Special | Citation |
|---|---|---|---|---|---|---|
| **AL** | 8a–8p | 8a–8p | **No calls** | **No calls** | 17 state holidays | Ala. Admin. Code r. 770-X-5-.17 |
| **AK** | fed | fed | fed | — | — | 8a–9p AK time (fed) |
| **AZ** | fed | fed | fed | — | AZ does not observe DST (except Navajo Nation) — `America/Phoenix` | 8a–9p AZ time |
| **AR** | fed | fed | fed | — | — | 8a–9p (fed) |
| **CA** | 8a–9p (live); ADAD 9a–9p | same | same | — | Auto-dial-announcing-device statute Cal. PUC § 2871–2876: ADAD only 9a–9p PT, must have live intro & consent | Cal. PUC § 2872 |
| **CO** | fed | fed | fed | — | CO Telephone Consumer Solicitation Act adds DNC, not hours | 8a–9p (fed) |
| **CT** | **9a–8p** | 9a–8p | 9a–8p | — | Stricter both ends | Conn. Gen. Stat. § 42-288a(c) |
| **DE** | fed | fed | fed | — | — | 8a–9p (fed) |
| **DC** | fed | fed | fed | — | — | 8a–9p (fed) |
| **FL** | **8a–8p** | 8a–8p | 8a–8p | — | FTSA; **3 calls / 24h same subject**; SMS covered | Fla. Stat. § 501.616 |
| **GA** | fed | fed | fed | — | GA Fair Business Practices Act adds DNC | 8a–9p (fed) |
| **HI** | fed | fed | fed | — | `Pacific/Honolulu`, no DST | 8a–9p HST |
| **ID** | fed | fed | fed | — | Spans MT/PT — handle by NXX | 8a–9p |
| **IL** | fed (9a-9p per some sources) | fed | fed | — | IL Auto Dialer Act adds autodialer rules | 815 ILCS 305 |
| **IN** | fed | fed | fed | — | **Tz split** ET/CT — see §6 | Ind. Code § 24-4.7 |
| **IA** | fed | fed | fed | — | — | — |
| **KS** | fed | fed | fed | — | — | — |
| **KY** | **10a–9p** | 10a–9p | 10a–9p | — | Latest start in nation | KRS 367.46955 |
| **LA** | **8a–8p** | 8a–8p | **No calls** | **No calls (incl. Mardi Gras, Good Friday)** | State-of-emergency areas blocked | La. R.S. 45:844.31 |
| **ME** | **9a–5p (auto only)** | 9a–5p (auto) | **No (auto)** | — | Maine restrictions are autodialer-specific; live calls follow fed; max 1 auto-call / 8h | 10 M.R.S. § 1498 |
| **MD** | **8a–8p** | 8a–8p | 8a–8p | — | Stop the Spam Calls Act; **3 calls / 24h** | Md. Com. Law 14-3201 |
| **MA** | **8a–8p** | 8a–8p | 8a–8p | — | AG enforcement | MGL Ch. 159C § 3 |
| **MI** | **9a–9p** | 9a–9p | 9a–9p | — | — | MCL 750.540e(f) |
| **MN** | **9a–9p** | 9a–9p | 9a–9p | — | — | Minn. Stat. § 325E.30 |
| **MS** | **8a–8p** | 8a–8p | **No calls** | — | Holiday prohibition repealed 2024 | Miss. Code Ann. § 77-3-723 |
| **MO** | fed | fed | fed | — | — | — |
| **MT** | fed | fed | fed | — | — | — |
| **NE** | fed | fed | fed | — | — | — |
| **NV** | fed | fed | fed | — | — | — |
| **NH** | fed | fed | fed | — | — | — |
| **NJ** | fed | fed | fed | — | — | — |
| **NM** | fed | fed | fed | — | — | — |
| **NY** | fed | fed | fed | — | NY Gen. Bus. Law § 399-z DNC; no stricter hours | 8a–9p (fed) |
| **NC** | fed | fed | fed | — | — | — |
| **ND** | fed | fed | fed | — | — | — |
| **OH** | fed | fed | fed | — | — | — |
| **OK** | **8a–8p** | 8a–8p | 8a–8p | — | OTSA; **3 calls / 24h same subject**; broad autodialer def | 15 OK Stat. § 775C.4 |
| **OR** | fed | fed | fed | — | — | — |
| **PA** | 8a–9p | 8a–9p | **noon–9p** | **No calls** | Sunday morning blackout | 73 P.S. § 2245.4 |
| **RI** | **9a–6p** | **10a–5p** | **No calls** | **No calls** | Most restrictive in nation | R.I. Gen. Laws § 5-61-2 |
| **SC** | fed | fed | fed | — | — | — |
| **SD** | fed | fed | fed | — | — | — |
| **TN** | fed | fed | fed | — | — | — |
| **TX** | **9a–9p** | **9a–9p** | **noon–9p** | — | SB 140 (effective Sep 1, 2025) extends to texts; Chapter 301/302 quiet hours unchanged | Tex. Bus. & Com. Code § 301.051 |
| **UT** | 8a–9p | 8a–9p | **No calls** | **No calls** | Class A misdemeanor for violation | Utah Code Ann. § 13-25a-103 |
| **VT** | fed | fed | fed | — | — | — |
| **VA** | fed | fed | fed | — | — | — |
| **WA** | **8a–8p** | 8a–8p | 8a–8p | — | RCW 80.36.390; third-party liability; **no B2B exemption** | RCW 80.36.390 |
| **WV** | fed | fed | fed | — | — | — |
| **WI** | fed | fed | fed | — | — | — |
| **WY** | **8a–8p** | 8a–8p | 8a–8p | — | Up to $10k/violation | Wyo. Stat. § 40-12-302 |

**Territories** (US outbound dialing):
- **PR** — `America/Puerto_Rico`, no DST. Federal TCPA applies. AST -4.
- **USVI** — `America/St_Thomas` / `America/Puerto_Rico`-equivalent, no DST.
- **GU / MP (Saipan)** — `Pacific/Guam`, no DST. ChST UTC+10. Federal TCPA applies but plaintiffs rare.
- **AS (American Samoa)** — `Pacific/Pago_Pago`, UTC-11.

---

## 4. NPA-NXX → tz data source choice

### 4.1 Options surveyed

| Source | Granularity | Cost | Update cadence | Pros | Cons |
|---|---|---|---|---|---|
| **libphonenumber `PhoneNumberToTimeZonesMapper` (via nyaruka/phonenumbers Go port)** | NPA-only for US | Free, Apache-2.0/MIT | Quarterly (CLDR) | Battle-tested, IANA names returned, embedded in binary, used by Signal | **NPA granularity only** — misses Indiana NXX splits |
| **NANPA NPA Reports (CSV)** | NPA-only | Free | Monthly | Authoritative source | NPA-only; needs custom join to tz |
| **Local Calling Guide (`localcallingguide.com`)** | NXX | Free, scrapable | Daily | Has rate centers + state | Scraping legality / TOS unclear; not stable for prod |
| **TelcoData / GreatData / NPANXXSource** | NXX | $50–500/yr | Quarterly | NXX-granular, well-maintained, includes wireless flag | Commercial; vendor lock |
| **`djbelieny/geoinfo-dataset` (GitHub)** | ZIP + NPA-NXX | Free, public domain | Stale (2018) | One CSV combining ZIP+NPA-NXX+tz | **Stale** — must verify against current data |
| **GeoScrub API (DNCScrub.com)** | Real-time | Pay-per-query | Live | TCPA-aware, includes state rules | External dependency in hot path; cost |
| **Vicidial `vicidial_phone_codes` (legacy)** | NPA + sometimes NXX | Free, GPL | Manual | Working reference impl | Static, mid-2010s data |

### 4.2 Recommendation for Phase 1

**Hybrid approach (matches D03 module's Luxon/Node design):**

1. **Primary lookup:** Static NPA-NXX → IANA-tz table seeded into `phone_codes` (F02 schema). Source: NANPA NPA report joined with a timezone CSV, supplemented by Local Calling Guide for NXX granularity in **Indiana, Idaho, Kentucky, Tennessee, Florida-panhandle, North Dakota, Nebraska, Oregon (Malheur), South Dakota** — the eight states that span tz boundaries. ~280 NPAs × ~600 active NXXs each ≈ 168k rows; a few MB. Trivial to cache full table in memory.

2. **Library fallback for E.164 parsing only:** Use `nyaruka/phonenumbers` (Go port of libphonenumber) for parsing/validation/national-number extraction. Do **not** rely on its `GetTimezonesForNumber` for the gate — it's NPA-granular and misses Indiana splits. Use it only as a sanity-check ("did our DB lookup return a tz consistent with libphonenumber's NPA-level tz?").

3. **ZIP-tz override:** When `lead.zip` is present (set during D02 CSV import), join against a US ZIP→tz table. Use Census ZCTA + IANA crossref, or open-source `pgeocode` data. ZIP-level tz is more accurate than NPA-NXX for non-portable customers. Stored in `phone_codes`-adjacent `zip_codes` table (F02).

4. **D03 (Node) and C01 (Node, per `C01.md`):** D03 owns the resolver; C01 wraps it for the gate. Both run in the API Node service. Library: **Luxon** for IANA tz arithmetic + DST.

5. **Go side (E01 hopper filler, E02 pacing):** Calls C01 via gRPC (`shared/proto/compliance.proto`) at hopper-fill and origination time. Caches result for 60s with `(lead_id, campaign_id, hour_bucket)` key — leads re-evaluated once per hour minimum (DST safety: re-evaluate on day boundaries).

### 4.3 Specific Indiana / split-state seeding

Eight states have NXX-level tz splits:

| State | Split | Source | Notes |
|---|---|---|---|
| **IN** | Most ET, NW + SW counties (Lake, Porter, LaPorte, Newton, Jasper, Starke, Pulaski; Gibson, Posey, Vanderburgh, Warrick, Spencer, Perry — partial; Daviess, Knox, Martin, Pike, Dubois) CT | DOT 49 CFR Part 71 | NPAs 219, 574, 765, 812 each contain mixed-tz NXXs |
| **KY** | Most ET, western counties CT | DOT | NPAs 270, 364, 502, 606, 859 |
| **TN** | West (Memphis) CT, East ET | DOT | NPAs 423, 615, 731, 865, 901, 931 |
| **FL** | Panhandle (west of Apalachicola River) CT | DOT | NPA 850 includes both |
| **ID** | Southern PT, North MT | DOT | NPAs 208, 986 |
| **OR** | Malheur County MT, rest PT | DOT | NPA 541 |
| **ND** | Most CT, west MT | DOT | NPA 701 |
| **SD** | East CT, west MT | DOT | NPAs 605 |
| **NE** | Most CT, west MT | DOT | NPAs 308, 402, 531 |

Seed this from a curated CSV in `phone_codes_seed.csv`, regenerated quarterly from Local Calling Guide rate-center exports.

---

## 5. Number portability problem + ZIP-override mitigation

### 5.1 The problem

Local Number Portability (LNP, FCC adopted 2003) means a phone number's NPA-NXX no longer reliably indicates the subscriber's location. Mobile customers especially keep their number when moving cross-country. Roughly **40%+ of US adults have moved across state lines while keeping their cell**, per industry estimates. The plaintiff bar exploits this:
- *Bernal v. Mixtiles USA, Inc.* (S.D.N.Y. 2025): plaintiff alleged Pacific-time texts violated quiet-hours despite defendant's ET-based lookup. Plaintiff "lived in California with a 209 area code" — NPA matched. But other 2025 suits target portability mismatches.
- Several active 2025 cases turn on whether area-code-based tz determination is a "defensible position" or actionable.

Industry consensus per *Privacy World* and *Mac Murray & Shuster*: area-code lookup is **defensible-but-not-bulletproof**. Best practice is a multi-source fallback.

### 5.2 Mitigation: 4-tier fallback (the gate's tz-resolution algorithm)

```
function resolveTz(lead) -> {tz: IANA, source: enum, confidence: enum}:
  if lead.known_timezone is not null:
    return {tz: lead.known_timezone, source: "explicit", confidence: HIGH}
  if lead.zip is non-empty and lookupZip(lead.zip) succeeds:
    return {tz: zip_tz, source: "zip", confidence: HIGH}
  if lead.state is non-empty and isSingleTzState(lead.state):
    return {tz: stateTz(lead.state), source: "state", confidence: MED}
  if phone NPA-NXX lookup succeeds:
    return {tz: npa_nxx_tz, source: "npa_nxx", confidence: MED}
  if phone NPA lookup succeeds (libphonenumber fallback):
    return {tz: npa_tz, source: "npa", confidence: LOW}
  if campaign.default_timezone:
    return {tz: campaign_default, source: "campaign", confidence: LOW}
  return {tz: null, source: "none", confidence: NONE}  -- caller must BLOCK or warn-pass per campaign config
```

Confidence is logged per dial; auditors and counsel see in DNC defense package.

### 5.3 Lead-level explicit override

`leads.known_timezone VARCHAR(64)` (IANA name, nullable). Set during:
- CSV import if column present
- Agent UI when called party reveals location ("I'm in Phoenix")
- Webhook from external CRM

This is **the most legally defensible signal** when present and is checked first.

### 5.4 Cell vs landline portability

- Use `libphonenumber.GetNumberType()` to identify CELL/MOBILE vs LANDLINE.
- For cell numbers without `lead.zip`, log confidence as MEDIUM regardless of NXX result.
- Future enhancement: integrate with carrier-lookup service (Neustar, RealPhoneValidation) to identify current carrier — out of scope Phase 1, document as a Phase 4 hardening hook (link to N06 Reassigned Numbers DB).

---

## 6. The gate algorithm (pseudocode)

### 6.1 Public API (matches `C01.md` interface, expanded)

```typescript
// Node (api/src/services/compliance/call-window.ts)
export async function assertCallWindow(opts: {
  phoneE164: string;
  campaignId: string;
  leadId?: bigint;
  when?: Date;            // default new Date(); injectable for testing
  enforcementPoint: 'hopper' | 'originate' | 'pacing';  // for audit only
}): Promise<CallWindowResult>;

export type CallWindowResult =
  | { decision: 'ALLOW';      tz: string; localTime: string; ruleApplied: string }
  | { decision: 'SKIP_UNTIL'; tz: string; localTime: string; nextOpenAt: Date; reason: string }
  | { decision: 'BLOCK';      tz?: string; reason: 'OUTSIDE_WINDOW' | 'STATE_BLACKOUT' | 'HOLIDAY' | 'UNKNOWN_TZ_DENY' };

// Throws AppError('OUTSIDE_CALL_WINDOW', { localHour, allowed, source }) on BLOCK if caller wants throw-style.
```

### 6.2 Algorithm

```
function assertCallWindow(phoneE164, campaignId, when=now()):

  # ─── Step 1: load context (cached) ───
  lead     := loadLead(phoneE164)               # may be null for ad-hoc dials
  campaign := loadCampaign(campaignId)
  tzResult := resolveTz(lead, phoneE164)        # 4-tier fallback per §5.2

  if tzResult.tz is null:
    if campaign.unknown_tz_policy == 'allow_with_warning':
      auditLog(decision=ALLOW_WARN, ...)
      return ALLOW(rule='unknown_tz_pass')
    else:  # 'deny' is default
      auditLog(decision=BLOCK, reason=UNKNOWN_TZ_DENY, ...)
      return BLOCK(reason=UNKNOWN_TZ_DENY)

  # ─── Step 2: compute called-party local time ───
  loc := IANA.ZoneInfo(tzResult.tz)
  partyTime := when.in(loc)                    # dst-aware, via Luxon DateTime.fromJSDate(...).setZone(...)
  partyDow  := partyTime.weekday               # 1=Mon..7=Sun
  partyHM   := partyTime.hour*60 + partyTime.minute
  partyDate := partyTime.toISODate()

  # ─── Step 3: build effective window ───
  # Federal floor:
  fedWindow := {start: 8*60, end: 21*60}       # 08:00 – 21:00

  # State override (most-restrictive-wins):
  state := lead.state ?? stateOf(tzResult)
  stateRule := stateRules[state]               # may include sunday_blackout, holiday_blackout, alt window
  if stateRule.sunday_blackout and partyDow == 7:
    return BLOCK(reason=STATE_BLACKOUT, rule=`${state}_sunday`)
  if stateRule.holiday_blackout and isStateHoliday(state, partyDate):
    return BLOCK(reason=HOLIDAY, rule=`${state}_holiday`)
  stateWindow := stateRule.windowFor(partyDow)  # e.g. RI Sat: 10:00-17:00

  # Campaign window (already configured by admin in M02):
  campWindow := campaign.callWindowFor(partyDow)  # campaign may impose narrower

  effective := intersect(fedWindow, stateWindow, campWindow)

  # ─── Step 4: in-window check ───
  if partyHM < effective.start:
    nextOpen := loc.midnight(partyDate) + effective.start min
    return SKIP_UNTIL(nextOpen, reason=BEFORE_WINDOW)

  if partyHM >= effective.end:
    # Stop at end-30s (configurable) to avoid abandons-after-close
    nextOpen := loc.midnight(partyDate + 1day) + effective.start min
    return SKIP_UNTIL(nextOpen, reason=AFTER_WINDOW)

  # ─── Step 5: boundary deprioritization (E02 only) ───
  if enforcementPoint == 'pacing':
    minutesToClose := effective.end - partyHM
    if minutesToClose < 5:
      # Hint to pacing: do not start new originates for this lead
      return SKIP_UNTIL(nextOpen=loc.midnight+effective.start, reason=BOUNDARY_AVOID)

  # ─── Step 6: ALLOW ───
  auditLog(decision=ALLOW, tz=tzResult.tz, localTime=partyTime, ruleApplied=`${state}_${partyDow}`)
  return ALLOW(rule=`${state}_${partyDow}`)
```

### 6.3 Test invariants
- **Federal floor never weakens:** even if campaign config tries `start: 06:00`, effective.start is `max(camp, fed) = 08:00`.
- **State strictness wins:** RI Sat 10–17 + campaign 8–21 → effective 10–17.
- **DST transitions:** when partyDate crosses spring-forward, the 02:00 hour doesn't exist locally. Luxon handles via `DateTime.fromObject({...}, {zone}).isValid` — invalid times normalize forward. Test fixtures cover both transitions.
- **Cross-midnight states:** none in US (no state allows midnight calls), but algorithm rejects any window where end < start.

---

## 7. Where the gate runs (3 enforcement points)

### 7.1 Hopper filler — E01 (Phase 2; Phase 1 manual-only)
- **Where:** `dialer/internal/hopper/filler.go`
- **When:** every ~60s when refilling per-campaign hopper
- **Behavior:** for each candidate lead, call `assertCallWindow(...)`.
  - `ALLOW` → insert into hopper sorted-set with priority score.
  - `SKIP_UNTIL` → defer; insert into delayed-set keyed on `nextOpenAt`. A separate worker re-injects when timer fires.
  - `BLOCK` → mark lead `tz_blocked=true` with reason; surface in admin (M03) for review.
- **Why early gate:** efficient — leads outside window never enter the active dial pool, no wasted churn.

### 7.2 Originate path — T04
- **Where:** `dialer/internal/originate/dial.go` (Go) — and `api/src/services/dialer/manual-dial.ts` (Node, manual-dial path)
- **When:** immediately before `bgapi originate` to FreeSWITCH ESL
- **Behavior:** re-call `assertCallWindow(...)`. This is the **last-chance gate**. If the lead has been in the hopper for 5+ minutes and the window has since closed, this catches it.
- **Why double-check:** required by `C01.md` Risks section. Time elapsed between hopper insert and dial can cross the 9pm boundary on busy systems. Hopper-insert was a hint; originate-time is the contract.
- **On BLOCK at originate:** log + emit `vici2.dial.blocked_at_originate` event + return error to caller (manual UI shows "outside call window"; auto-dialer marks lead for retry).

### 7.3 Pacing loop — E02 (Phase 2)
- **Where:** `dialer/internal/pacing/loop.go`
- **When:** the ~3-second pacing tick that decides how many lines to dial per campaign per ready agent
- **Behavior:** for each lead the picker would select, call `assertCallWindow(enforcementPoint='pacing')`. The pacing variant additionally returns SKIP if `minutesToClose < 5` to deprioritize boundary leads.
- **Why:** pacing-overdial near 8:59pm risks an answered call ringing at 9:01pm called-party time → drop or compliance breach if agent doesn't pick up in 2s.
- **Integration with E05 drop-rate:** pacing must stop *initiating new* origins ≥30s before window-close. In-flight legs continue; the `dial_timeout_sec` (default 22s) ensures no leg rings past 9:00:22.

### 7.4 Defense-in-depth rationale
Three checks because each enforcement point has different staleness:
- Hopper: minutes-to-hours stale (lead may sit in hopper)
- Originate: seconds stale (immediate)
- Pacing: real-time but advisory

If any one check is bypassed, the others catch it. SPEC.md §4.1 explicitly enumerates this: "8am–9pm called-party-local-time gate (enforced in hopper filler, double-checked at originate)".

---

## 8. Audit-log requirements

### 8.1 Schema (links to F02 + C03 immutability)

`call_window_audit` table (immutable; see C03 for retention/lock):

```sql
CREATE TABLE call_window_audit (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  ts            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  tenant_id     BIGINT NOT NULL DEFAULT 1,
  lead_id       BIGINT,
  phone_e164    VARCHAR(16) NOT NULL,
  campaign_id   VARCHAR(32) NOT NULL,
  decision      ENUM('ALLOW','ALLOW_WARN','SKIP_UNTIL','BLOCK') NOT NULL,
  reason        VARCHAR(64),                   -- OUTSIDE_WINDOW / STATE_BLACKOUT / HOLIDAY / UNKNOWN_TZ_DENY / ...
  tz_resolved   VARCHAR(64),                   -- IANA name e.g. America/New_York
  tz_source     ENUM('explicit','zip','state','npa_nxx','npa','campaign','none'),
  tz_confidence ENUM('HIGH','MED','LOW','NONE'),
  state         CHAR(2),
  zip           VARCHAR(10),
  party_local   DATETIME(3),                   -- party local time at moment of decision
  party_dow     TINYINT,                       -- 1..7 Mon=1
  effective_start_min SMALLINT,                -- e.g. 480 (08:00)
  effective_end_min   SMALLINT,                -- e.g. 1260 (21:00)
  rule_applied  VARCHAR(64),                   -- e.g. 'fed_8_21' or 'RI_Sat_10_17'
  enforcement_point ENUM('hopper','originate','pacing','manual') NOT NULL,
  next_open_at  DATETIME(3),                   -- if SKIP_UNTIL
  call_uuid     VARCHAR(64),                   -- if attached to a specific FS call attempt
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (lead_id, ts),
  INDEX (campaign_id, decision, ts),
  INDEX (ts)
) PARTITION BY RANGE (TO_DAYS(ts));            -- monthly partitions for retention
```

### 8.2 Required fields (legal review requirements)
- All inputs to the tz computation (state, zip, phone, known_tz)
- The tz that was selected and its source/confidence
- The local time computed at the called party
- The window applied (federal vs state vs campaign — by name)
- Decision and reason
- Enforcement point (so we can show defense-in-depth in court)
- Linked `call_uuid` when a real call attempt followed (joinable to `call_log`)

### 8.3 Volume considerations
- Phase 2 auto-dial: a single 100-agent call center may evaluate ~50k tz-checks/day (pacing loop dominates). If we logged every pacing check, that's ~18M rows/year/100-agent.
- **Sampling rule:** log all `BLOCK` and `SKIP_UNTIL`; sample `ALLOW` at 1% (configurable). Pacing-point ALLOWs that are followed by a successful originate are reconstructable from `call_log` cross-reference.
- Storage: partition monthly, archive to S3 with object-lock per C03 after 90d; 4-year retention per C04.

### 8.4 Observability
Prometheus metrics:
- `vici2_compliance_window_decisions_total{decision, reason, enforcement_point, state}`
- `vici2_compliance_tz_resolutions_total{source, confidence}`
- `vici2_compliance_unknown_tz_total{campaign}`  (alert >100/h)

Grafana dashboard panel: "Daily TCPA gate activity" with rolling block/skip counts, top reason codes, top blocked states.

---

## 9. Edge cases

### 9.1 Indiana NXX-level tz split
- 12 IN counties are CT; rest ET. Within NPAs 219, 574, 765, 812 some NXX go each way.
- libphonenumber returns `America/New_York` for entire IN — wrong for CT counties.
- **Mitigation:** seed `phone_codes` with NXX-level resolution for all 8 split states. Local Calling Guide rate-center data + IANA tz crosswalk gives this. Quarterly refresh script.
- **Test fixture:** Hammond IN (Lake County, NPA 219, NXX e.g. 933) → `America/Chicago`. Indianapolis IN (Marion County, NPA 317) → `America/Indianapolis`. Both must resolve correctly.

### 9.2 Hawaii / Alaska / Pacific territories
- `Pacific/Honolulu` (no DST) — federal TCPA applies. NPA 808.
- `America/Anchorage` (DST) — fed TCPA. NPAs 907.
- `America/Puerto_Rico` (no DST) — fed TCPA. NPAs 787, 939.
- `America/St_Thomas` USVI (no DST) — fed TCPA. NPA 340.
- `Pacific/Guam` (no DST, ChST UTC+10) — fed TCPA. NPA 671. CNMI/Saipan shares.
- `Pacific/Pago_Pago` American Samoa (no DST, UTC-11) — fed TCPA. NPA 684.
- **Test fixtures:** one per territory; especially Saipan (Pacific/Guam) is a 14-hour offset from US East — easy bug to introduce by sloppy offset arithmetic.

### 9.3 Arizona DST exception
- Arizona observes MST year-round (`America/Phoenix`) — except Navajo Nation (`America/Denver` portion) which does observe DST.
- libphonenumber returns `America/Phoenix` for all NPA 480/520/602/623/928. **Acceptable** — Navajo Nation overlap is small and conservative-side error (we'd dial 1h late at most).

### 9.4 Border-state numbers
- 928 AZ borders 970 CO and 435 UT. Numbers stay in NPA. NPA-level lookup correct.
- 504/985 LA borders 228 MS — CT both sides. No issue.
- **Edge case:** 215 PA borders 856 NJ across Delaware River. Both ET. No issue.

### 9.5 B2B exemption
- FTC TSR (16 CFR § 310.6(b)(7)) exempts most B2B from federal DNC, **but not from time-of-day rules**.
- FCC TCPA: B2B autodialed/prerecorded calls to *wireless* still require consent.
- Washington explicitly has **no B2B exemption** at all.
- **Decision for Phase 1:** the gate runs the same regardless of `lead.is_business`. If we add a `lead.b2b_skip_window` flag in Phase 4, it requires legal sign-off and per-state matrix. Document as Phase 4+ feature in HANDOFF.

### 9.6 Established Business Relationship (EBR)
- EBR exempts from DNC (federal) but **not from time-of-day rule** in 47 CFR § 64.1200(c)(1).
- Confusingly, the FCC's *internal DNC* rule has an EBR exception. The time-window does not.
- **Decision:** gate ignores EBR. If campaign allows EBR-bypass-DNC, gate still runs.

### 9.7 Manual-dial agent override
- Sometimes an agent has consent and wants to call *now* outside the window.
- **Conservative posture for Phase 1:** no override. Manual dial UI shows error "outside call window" with no force option. Reasoning: an "override" feature is exactly the kind of artifact a plaintiff's lawyer subpoenas and points at.
- If business demand requires it later, gate it behind a per-user role + per-call legal-justification text field, all logged immutably.

### 9.8 Callback at scheduled time
- D06 callbacks let agent schedule e.g. "call back at 3pm tomorrow." The scheduled time is in agent-or-lead local. When the callback fires, the gate must still validate.
- **Behavior:** callback fire at scheduled wall-clock; gate runs at fire time; if blocked, reschedule to next-open with notification to agent.

### 9.9 Outbound from international agent
- Agent location is irrelevant. Gate is on called party. Document explicitly to prevent confusion.

### 9.10 SMS / voicemail-drop
- 2025 case wave (Bernal et al.) treats SMS as subject to the same time window. C02 (recording consent) and any future SMS module must use C01 gate.
- Voicemail-drop after answer: if the call connected before 9pm and went to VM, dropping a message at 9:01pm is generally OK because the call originated in-window. But err on the side of caution — if `now() > effective.end`, don't initiate new VM drops.

---

## 10. Test fixtures needed

A `tz_test_fixtures.json` shipped with C01 unit tests. Each fixture: `{ phone, expected_tz, state, zip?, known_tz?, when, expected_decision, expected_reason }`.

| # | Lead description | Phone | State | Frozen `when` | Expected |
|---|---|---|---|---|---|
| 1 | NYC 10am ET | +12125551212 | NY | 2026-06-15 14:00 UTC | ALLOW |
| 2 | NYC 3am ET | +12125551212 | NY | 2026-06-15 07:00 UTC | SKIP_UNTIL 12:00 UTC |
| 3 | LA 7:30am PT | +13105551212 | CA | 2026-06-15 14:30 UTC | SKIP_UNTIL 15:00 UTC |
| 4 | LA 8:30pm PT (CA ADAD post-9pm) | +13105551212 | CA | 2026-06-16 03:30 UTC | ALLOW (CA is fed for non-ADAD) |
| 5 | Hammond IN (Central) 7am CT | +12199335555 | IN | 2026-06-15 12:00 UTC | SKIP_UNTIL 13:00 UTC |
| 6 | Indianapolis IN (Eastern) 7am ET | +13175551212 | IN | 2026-06-15 11:00 UTC | SKIP_UNTIL 12:00 UTC |
| 7 | Honolulu 9pm HST | +18085551212 | HI | 2026-06-16 07:00 UTC | SKIP_UNTIL 18:00 UTC |
| 8 | Anchorage DST spring-forward | +19075551212 | AK | 2026-03-08 09:00 UTC (during transition) | ALLOW or SKIP — verify Luxon handles |
| 9 | Anchorage DST fall-back | +19075551212 | AK | 2026-11-01 09:00 UTC | ALLOW |
| 10 | San Juan PR 9pm AST | +17875551212 | PR | 2026-06-16 01:00 UTC | SKIP_UNTIL |
| 11 | St. Thomas USVI 8pm AST | +13405551212 | VI | 2026-06-16 00:00 UTC | ALLOW |
| 12 | Saipan 8am ChST | +16705551212 | MP | 2026-06-14 22:00 UTC | ALLOW |
| 13 | American Samoa 7am SST | +16845551212 | AS | 2026-06-15 18:00 UTC | SKIP_UNTIL |
| 14 | Birmingham AL Sunday 10am | +12055551212 | AL | 2026-06-14 (Sun) 15:00 UTC | BLOCK STATE_BLACKOUT |
| 15 | New Orleans LA Sunday | +15045551212 | LA | 2026-06-14 (Sun) 15:00 UTC | BLOCK STATE_BLACKOUT |
| 16 | New Orleans LA Mardi Gras 2026 (Feb 17) | +15045551212 | LA | 2026-02-17 15:00 UTC | BLOCK HOLIDAY |
| 17 | Providence RI 7pm ET (RI 9-6) | +14015551212 | RI | 2026-06-15 23:00 UTC | BLOCK OUTSIDE_WINDOW |
| 18 | Lexington KY 9am | +18595551212 | KY | 2026-06-15 13:00 UTC (9am ET) | SKIP_UNTIL 14:00 UTC (KY 10am start) |
| 19 | Houston TX Sunday 11am | +17135551212 | TX | 2026-06-14 (Sun) 16:00 UTC | SKIP_UNTIL 17:00 UTC (TX Sun noon) |
| 20 | Tampa FL 8pm ET | +18135551212 | FL | 2026-06-16 00:00 UTC | BLOCK OUTSIDE_WINDOW (FL 8pm cutoff) |
| 21 | Number ported: NY area-code + CA zip | +12125551212 | CA (zip 90210) | 2026-06-15 11:00 UTC | use ZIP → SKIP (CA 4am) |
| 22 | Lead with `known_timezone='America/Phoenix'` | +12125551212 | (any) | 2026-06-15 14:00 UTC | use explicit → AZ time |
| 23 | Unknown NPA 999 (invalid) | +19995551212 | (none) | any | BLOCK UNKNOWN_TZ_DENY (default policy) |
| 24 | Unknown NPA, campaign allows warn-pass | +19995551212 | (none) | any | ALLOW_WARN |
| 25 | At exactly 8:00:00am | various | NY | 2026-06-15 12:00:00 UTC | ALLOW |
| 26 | At exactly 8:59:30pm (boundary advisory) | various | NY | 2026-06-15 00:59:30 UTC | pacing: SKIP, originate: ALLOW |
| 27 | Maine automated call at 6pm | +12075551212 | ME | 2026-06-15 22:00 UTC, campaign `is_autodialer=true` | BLOCK (ME 9–5 auto only) |
| 28 | DST transition: lead in NY on 2026-03-08 02:30 (skipped hour) | +12125551212 | NY | 2026-03-08 07:30 UTC | ALLOW or normalized — verify |

Coverage target: ≥95% line coverage on `call-window.ts` per C01 acceptance criteria.

---

## 11. Open questions for PLAN

1. **Configurable unknown-TZ default per campaign or system-wide?** SPEC implies per-campaign. Confirm in PLAN.
2. **Should `known_timezone` be on `leads` or a new `lead_tz_overrides` table?** Argument for separate table: history (audit trail of who set/changed it). Lean toward `leads.known_timezone` with audit row in C03 audit_log on change.
3. **Where do state holidays live?** New `state_holidays` table in F02 (date, state, holiday_name, type). Seed from a curated CSV. Annual refresh.
4. **Maine autodialer detection.** ME's stricter window applies only to autodialed calls. The gate needs to know `campaign.is_autodialer` (already in F02 `dial_method`). Express in `state_rules` as `auto_only_window: { start, end }`.
5. **Frequency caps (FL, OK, MD).** Out of scope for C01 itself. Add to D04 (status definitions) or a new C05 (frequency cap). Flag in handoff.
6. **EIA Petition outcome.** If FCC rules consent moots quiet-hours, we add an opt-in path for consented numbers. Phase 4. For Phase 1, gate runs unconditionally.
7. **Throw vs return for `assertCallWindow`?** `C01.md` shows `Promise<void> | throws`. Recommend changing to discriminated-union return (`CallWindowResult`) — easier to test, avoids try/catch in hot pacing loop. Mini-RFC needed.
8. **Caching strategy.** Per-(lead, hour-bucket) cache for 60s. Eviction on lead update. Gate must NOT cache across `when`-changes that cross window boundaries; key by `(phone, floor(when/300s))` to be safe.
9. **gRPC vs HTTP from Go dialer to Node API?** SPEC §3.9 uses gRPC for Go↔Node. C01 is Node-side; Go dialer calls in. Define `compliance.proto` `CallWindowService.Check(req)`.
10. **Local-cache redundancy:** Go dialer should also have a slim local copy of `phone_codes` to avoid round-trip on every pacing tick. Sync via Redis or DB tail. Confirm in PLAN.
11. **DST off-by-one regression suite.** Run nightly on a date 1 minute after each US DST transition for the next 5 years to confirm correctness.
12. **Fixture data freshness:** how often do we regenerate `phone_codes_seed.csv`? Quarterly cron? Manual?

---

## 12. Citations

### Federal authorities
1. 47 U.S.C. § 227 — TCPA. https://www.law.cornell.edu/uscode/text/47/227
2. 47 CFR § 64.1200 — FCC implementing rule. https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200
3. 16 CFR § 310 — FTC Telemarketing Sales Rule. https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule
4. FCC 23-107 — Lead Generator Order (Dec 2023, effective Jan 27, 2025). https://docs.fcc.gov/public/attachments/DOC-408396A1.pdf
5. FCC 24-24 — Revocation of Consent Order; portion delayed to Jan 31, 2027. https://www.hunton.com/privacy-and-cybersecurity-law-blog/burdensome-portion-of-tcpa-rule-delayed-through-april-2026
6. DA 26-12 — FCC clarification (Jan 2026). https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf
7. DA 25-312 — FCC further interpretation. https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf
8. Bernal v. Mixtiles USA, Inc. — 2025 quiet-hours class action exemplar. https://natlawreview.com/article/its-past-time-mixtiles-sued-violating-time-zone-specific-provisions-tcpa
9. McLaughlin v. McKesson, 144 S. Ct. (2024) — courts no longer bound by FCC interpretations.
10. EIA Petition for Declaratory Ruling re Quiet Hours, FCC docket March 3, 2025. https://www.privacyworld.blog/2025/03/new-class-action-threat-tcpa-quiet-hours-and-marketing-messages/
11. DOT 49 CFR Part 71 — Standard time-zone boundaries. https://www.federalregister.gov/documents/2006/01/20/06-563/standard-time-zone-boundary-in-the-state-of-indiana

### State authorities
12. Cal. Pub. Util. Code §§ 2871–2876 (ADAD). https://law.justia.com/codes/california/2007/puc/2871-2876.html
13. Cal. AB 2905 (2024) — automatic dialing limits. https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240AB2905
14. Conn. Gen. Stat. § 42-288a — Connecticut DNC and hours.
15. Fla. Stat. § 501.616 — Florida Telephone Solicitation Act. https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.604.html
16. Fla. HB 761 (2023) — FTSA reform. https://www.bradley.com/insights/publications/2024/01/recent-court-rulings-reinforce-the-validity-of-floridaamended-telephone-solicitation-act
17. La. R.S. 45:844.31 — Sunday/holiday blackout, Mardi Gras + Good Friday.
18. 10 M.R.S. § 1498 — Maine automated calling restrictions.
19. Md. Com. Law 14-3201 — Stop the Spam Calls Act.
20. MGL Ch. 159C § 3 — Massachusetts solicitation hours.
21. MCL 750.540e(f) — Michigan calling hours.
22. Miss. Code Ann. § 77-3-723 — Mississippi Sunday blackout. https://www.dnc.com/blog/no-more-holidays-mississippi-marketers-magnolia-state-lifts-prohibition-telemarketing-legal
23. 15 Okl. St. § 775C.4 — Oklahoma Telephone Solicitation Act (OTSA).
24. 73 P.S. § 2245.4 — Pennsylvania Sunday noon restriction.
25. R.I. Gen. Laws § 5-61-2 — Rhode Island (most restrictive).
26. Tex. Bus. & Com. Code § 301.051 + SB 140 (eff. Sep 1, 2025). https://www.vorys.com/publication-texas-sb-140-requirements
27. Utah Code Ann. § 13-25a-103 — Utah Sunday/holiday blackout.
28. RCW 80.36.390 — Washington (no B2B exemption). https://www.dnc.com/dnc-tcpa-guides-and-checklists/risks-b2b-under-tcpa
29. Ind. Code § 24-4.7 — Indiana Telephone Privacy Act + 2025 amendments. https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/indiana-amends-telemarketing-law-bringing-new-disclosure-requirements-and-dnc-vicarious-liability
30. Wyo. Stat. § 40-12-302 — Wyoming.

### Industry / litigation analysis
31. Privacy World — TCPA Quiet Hours wave (Mar 2025). https://www.privacyworld.blog/2025/03/new-class-action-threat-tcpa-quiet-hours-and-marketing-messages/
32. Mac Murray & Shuster — Calling Hours navigation. https://mslawgroup.com/timing-is-everything-navigating-the-tcpas-allowable-calling-hours/
33. Benesch — Time-of-day TCPA cases. https://www.beneschlaw.com/insight/time-of-day-tcpa-cases-inundate-the-federal-docket/
34. Blank Rome — TCPA Quiet Hours navigation. https://www.blankrome.com/publications/tick-tock-dont-get-caught-navigating-tcpas-quiet-hours
35. Kaufman Dolowich — State Mini-TCPA Roundup (Aug 2025). https://www.kaufmandolowich.com/news-resources/law-alert-state-mini-tcpa-laws-growing-texas-latest-to-update-its-telemarketing-rules-8-21-2025-by-richard-j-perr-monica-m-littman-graeme-e-hogan-dominic-borelli-and-kristen-ruotolo/
36. Bradley — FTSA navigation. https://www.bradley.com/insights/publications/2024/11/navigating-claims-under-the-florida-telephone-solicitation-act-and-florida-telemarketing-act
37. Vorys — Texas SB 140. https://www.vorys.com/publication-texas-sb-140-requirements
38. Lead Gen Economy — 2026 State-by-State Calling Hours. https://www.leadgen-economy.com/blog/telemarketing-calling-hours-by-state/
39. ClickPoint — Telemarketing Calling Restrictions by State. https://blog.clickpointsoftware.com/telemarketing-calling-hours-by-state
40. ActiveProspect — TCPA Damages Guide. https://activeprospect.com/blog/tcpa-damages/
41. CompliancePoint — Comparing State Telemarketing Laws. https://www.compliancepoint.com/marketing-compliance/comparing-state-telemarketing-laws/
42. ViciStack — VICIdial Timezone-Aware Dialing & TCPA Safe Hours. https://vicistack.com/blog/vicidial-timezone-dialing-tcpa
43. DNC.com — Holiday Alerts. https://www.dnc.com/holiday-alerts/

### Technical / library references
44. Google libphonenumber — `PhoneNumberToTimeZonesMapper`. https://github.com/google/libphonenumber/blob/master/java/geocoder/src/com/google/i18n/phonenumbers/PhoneNumberToTimeZonesMapper.java
45. libphonenumber timezone metadata README. https://github.com/google/libphonenumber/blob/master/resources/timezones/README.md
46. nyaruka/phonenumbers (Go port). https://github.com/nyaruka/phonenumbers
47. Signal-Server reference impl using PhoneNumberToTimeZonesMapper. https://github.com/signalapp/Signal-Server/blob/main/service/src/main/java/org/whispersystems/textsecuregcm/scheduler/SchedulingUtil.java
48. NANPA NPA Reports. https://www.nanpa.com/reports/npa-reports
49. djbelieny/geoinfo-dataset (NPA-NXX + ZIP + tz). https://github.com/djbelieny/geoinfo-dataset
50. IANA Time Zone Database. https://www.iana.org/time-zones
51. Timezone Boundary Builder — IANA tz polygons. https://github.com/evansiroky/timezone-boundary-builder
52. Vicidial AST_VDhopper.pl — reference implementation of tz gate. https://github.com/inktel/Vicidial/blob/master/bin/AST_VDhopper.pl
53. GeoScrub API — commercial reference for the same logic. https://docs.dncscrub.com/api-reference/geoscrub/overview
54. Indiana DOT time zone boundary updates. https://www.federalregister.gov/documents/2006/01/20/06-563/standard-time-zone-boundary-in-the-state-of-indiana

---

## STOP. Do not proceed to PLAN. Awaiting checkpoint review.

Blocking dependencies before PLAN can proceed:
- **F02** schema must define `phone_codes`, `state_rules`, `state_holidays`, `call_window_audit`, `leads.known_timezone`, `leads.zip`, `campaigns.unknown_tz_policy`.
- **D03** timezone resolver public interface must be finalized — C01 is the wrapper around it.

When unblocked, the PLAN.md should:
1. Pin Luxon vs date-fns-tz (recommend Luxon for IANA + DST robustness)
2. Decide throw vs union-return API
3. Define gRPC `compliance.proto` for Go dialer → Node API gate calls
4. Decide caching keys/TTL with an eye on DST transitions
5. Specify Go-side local cache strategy for E01/E02 hot paths
6. Define `state_rules` JSON shape for state windows + holiday lookups
7. Lock the audit-log schema (above is a draft) with C03 owner
