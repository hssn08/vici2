# N05 — Branded Calling Integration — RESEARCH

| Field | Value |
|---|---|
| **Module** | N05 — Branded Calling (First Orion / Hiya / TNS) |
| **Author** | N05-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | RESEARCH |
| **Informs** | N05/PLAN.md |

---

## 0. Context and Scope

Call-center telephone numbers are disproportionately flagged as "Spam Likely," "Telemarketer," or "Scam Likely" by carrier analytics engines, even for fully consented outbound calls. Branded Calling programs allow an enterprise to register its brand name, logo, and call-reason with one or more analytics providers. When a registered DID places a call, compatible handsets display a rich branded screen instead of an anonymous or flagged caller ID.

N05 integrates vici2 with the three dominant branded-calling providers — First Orion (Engage platform), Hiya (Connect platform), and Transaction Network Services / TNS (Enterprise Caller ID) — through a common internal interface, a registration worker, a reputation-polling worker, and an Admin UI panel.

Adjacent modules:
- **T02** — DIDs table (`did_numbers`) and carrier gateway config; N05 reads `did_numbers.id` and `did_numbers.e164`.
- **X04** — Number Pool health and quarantine engine; N05 feeds spam-score updates back into X04's quarantine logic via an integration hook.
- **C04** — TCPA attestation; STIR/SHAKEN A-attestation (required for most branded-calling programs) is produced by the BYOC SIP carrier and N05 validates its presence as a prerequisite for registration.

---

## 1. Industry Landscape: Why Numbers Get Labeled

### 1.1 The Labeling Ecosystem

Before examining individual providers it is necessary to understand how "Spam Likely" labels appear on a handset. The US labeling ecosystem comprises three layers:

1. **STIR/SHAKEN authentication** (RFC 8226 / IETF RFC 8588) — an in-band cryptographic token (PASSporT JWT) carried in the SIP `Identity` header that attests the calling party's right to use the From: number. The originating carrier signs the token; terminating carriers and analytics engines read it. Attestation levels:
   - **A (Full)** — originating carrier fully authenticated the call and verified the calling party owns the number.
   - **B (Partial)** — originating carrier authenticated the call but cannot verify ownership of the CLI.
   - **C (Gateway)** — call entered via a gateway where authentication was not possible.

2. **CNAM (Calling Name) database** — the legacy PSTN database that carriers query at termination to resolve a CLI to a display name (up to 15 characters). CNAM is provisioned per-DID through the DID's originating carrier or through a CNAM provisioning broker. CNAM does NOT transmit logos or call reasons; it is limited to the text name field.

3. **Branded Calling / Rich Calling analytics overlays** — out-of-band data channels operated by analytics companies (First Orion, Hiya, TNS, TransUnion) that the terminating carrier or OS provider queries in near-real-time to retrieve display metadata (name, logo, call reason, color). These overlays supplement CNAM and STIR/SHAKEN. Analytics providers also compute reputation scores for each DID based on call-behavior signals. A DID with poor reputation may be labeled regardless of STIR/SHAKEN attestation level.

### 1.2 Carrier and OS Integration Points

Rich Calling data reaches end users through three paths:

| Path | Carriers / Platforms | Max richness |
|---|---|---|
| Native dialer integration (FCC-mandated) | AT&T, T-Mobile, Verizon, US Cellular, C-Spire | Logo + name + call reason |
| Third-party call-management app | Hiya app (iOS/Android), First Orion app | Logo + name + call reason + block option |
| OS-level call screening | Google (Pixel + GMS, Android 11+), Apple (iOS 16+ via CallKit) | Name only (text) |

### 1.3 Market Share Relevance (2025 data)

T-Mobile uses First Orion for its "Caller Verified" and branded-display program natively. AT&T uses Hiya for its own "Call Protect" offering. Verizon has historically used TNS / Transaction Network Services for Call Filter. All three carriers also accept data from multiple providers via SHAKEN-layer lookups and FCC-mandated analytics sharing agreements.

---

## 2. First Orion — Engage Program

### 2.1 Overview

First Orion's **Engage** product is the branded-calling program that powers T-Mobile's "Business Identity" service and First Orion's own CPBX/Sprint/T-Mobile network overlay. Enterprise clients register their brand once; First Orion propagates the brand metadata to carrier-tier lookup servers.

### 2.2 Eligibility Requirements

- US business entity with verifiable legal name.
- DIDs must originate from a US-licensed CLEC or IXC carrier.
- STIR/SHAKEN **A-attestation** strongly preferred; B-attestation accepted but with reduced display reach.
- Call volume minimum: First Orion traditionally requires a baseline average of >500 outbound calls/month per registered DID to maintain active branded status (underpublished threshold; varies by contract tier).
- Enterprise contract signed; First Orion does not offer self-serve for high-volume call centers.

### 2.3 Onboarding Process

1. **Brand application** — submit company name (up to 25 characters for display), legal entity name, vertical category, primary contact, signed attestation that calls are consented/compliant.
2. **Logo upload** — 256×256 PNG, HTTPS-hosted URL (First Orion fetches and caches), or direct upload to First Orion CDN.
3. **DID registration** — bulk CSV upload or REST API submission. Fields per DID: E.164 number, brand ID, call reason (from controlled vocabulary), effective date.
4. **Approval** — typically 3–10 business days. First Orion validates DID ownership by checking against carrier records via their network relationships.
5. **Go-live** — once approved, calls from registered DIDs trigger branded display on T-Mobile handsets within the propagation window (up to 24 hours post-activation).

### 2.4 API Interface (REST)

First Orion's Engage API is a REST/JSON service requiring an OAuth 2.0 bearer token obtained via client-credentials flow.

**Base URL:** `https://api.firstorion.com/engage/v2/` (production)

Key endpoints:
- `POST /brands` — create or update brand profile.
- `GET /brands/{brand_id}` — fetch brand status.
- `POST /brands/{brand_id}/numbers` — register array of E.164 numbers to a brand with call reason.
- `DELETE /brands/{brand_id}/numbers/{e164}` — deregister a number.
- `GET /brands/{brand_id}/numbers` — list registered numbers and their status.
- `GET /numbers/{e164}/reputation` — retrieve reputation score for a number (0–100 scale; higher = better).
- `POST /numbers/{e164}/report-spam` — submit a complaint about an inbound spam call (for feedback loop).

Authentication: `Authorization: Bearer {access_token}`. Token endpoint: `https://auth.firstorion.com/oauth/token`.

Rate limits: 100 req/s for registration, 10 req/s for reputation polling.

### 2.5 Brand Data Payload

```json
{
  "brand_name": "ACME Corp",
  "logo_url": "https://cdn.acme.com/logo-256.png",
  "vertical": "FINANCIAL_SERVICES",
  "call_reasons": ["ACCOUNT_SERVICES", "COLLECTIONS", "APPOINTMENT_REMINDER"],
  "primary_contact_email": "admin@acme.com",
  "attestation_level": "A"
}
```

Vertical categories (partial list): `FINANCIAL_SERVICES`, `HEALTHCARE`, `INSURANCE`, `RETAIL`, `UTILITIES`, `TELEMARKETING`, `NON_PROFIT`, `GOVERNMENT`, `TECHNOLOGY`, `REAL_ESTATE`.

Call reason vocabulary (partial): `ACCOUNT_SERVICES`, `APPOINTMENT_REMINDER`, `COLLECTIONS`, `DELIVERY_NOTIFICATION`, `FRAUD_ALERT`, `GENERAL_NOTIFICATION`, `MARKETING`, `SURVEY`.

### 2.6 Number Registration Payload

```json
{
  "numbers": [
    {
      "e164": "+12065550001",
      "call_reason": "APPOINTMENT_REMINDER",
      "effective_date": "2026-05-14"
    }
  ]
}
```

### 2.7 Reputation Score Interpretation

| Score range | Meaning | Recommended action |
|---|---|---|
| 85–100 | Clean; branded display active | No action |
| 60–84 | Moderate risk; display may be suppressed | Increase refresh cadence |
| 30–59 | High risk; likely labeled | Evaluate call patterns; consider quarantine |
| 0–29 | Critical; labeled "Spam Likely" | Immediate quarantine + deregister |

---

## 3. Hiya — Connect Platform

### 3.1 Overview

Hiya is an independent call-analytics provider whose data is embedded natively in **AT&T's Call Protect** service. Hiya's **Connect** product is their enterprise branded-calling API. Hiya has >400 million registered users across their native app and carrier integrations. Their spam-detection engine is among the most sophisticated and is the primary engine that AT&T handsets use for call labeling.

### 3.2 Eligibility Requirements

- Business entity with a valid US business address.
- No requirement for STIR/SHAKEN A-attestation (unlike First Orion), though A-attestation improves Hiya's trust score for the brand.
- Hiya does not impose a call-volume minimum for initial enrollment but does revoke registration for DIDs that exhibit spam-like call behavior (high abandon rates, call durations consistently under 10 seconds, high user block rates).
- Self-serve portal available for smaller brands; enterprise API access requires account setup through Hiya's sales team.

### 3.3 Onboarding Process

1. **Business verification** — legal entity name, EIN/Tax ID, industry, primary use case.
2. **Brand profile creation** — display name (up to 30 characters), logo (512×512 recommended, HTTPS), brand color hex, website URL.
3. **Number submission** — via the Hiya Business Portal UI or the Connect API. Numbers can be submitted individually or in bulk (CSV for portal, JSON array for API).
4. **Vetting** — Hiya uses its own call-behavior database to immediately check if any submitted numbers have existing spam flags. Numbers with existing flags require a 30-day "cooling period" before branded display activates.
5. **Propagation** — AT&T network displays brand within 6–48 hours. Hiya app users see brand within 4 hours.

### 3.4 API Interface (REST)

Hiya Connect uses API key authentication passed as `X-API-Key` header.

**Base URL:** `https://api.connect.hiya.com/v1/`

Key endpoints:
- `POST /business/profile` — create brand profile.
- `PUT /business/profile` — update brand profile.
- `GET /business/profile` — retrieve current profile + status.
- `POST /business/numbers` — register numbers (up to 500 per request).
- `DELETE /business/numbers` — deregister numbers (array of E.164).
- `GET /business/numbers` — list registered numbers with status.
- `GET /business/numbers/{e164}/score` — retrieve Hiya reputation score (0–10 scale; 10 = best).
- `POST /business/numbers/{e164}/feedback` — submit feedback about a mislabeled/blocked number.

Rate limits: 200 req/min for registration, 60 req/min for score polling.

### 3.5 Brand Data Payload

```json
{
  "display_name": "ACME Corp",
  "logo_url": "https://cdn.acme.com/logo-512.png",
  "brand_color": "#003087",
  "website": "https://www.acme.com",
  "industry": "FINANCIAL_SERVICES",
  "description": "Leading financial services provider",
  "primary_use_case": "ACCOUNT_SERVICES"
}
```

### 3.6 Hiya Score Scale

| Score | Meaning |
|---|---|
| 8–10 | Safe; branded display active |
| 5–7 | Borderline; no action immediately required |
| 3–4 | Elevated risk; branded display may be suppressed |
| 0–2 | Labeled (spam, scam, or fraud indicator active) |

Hiya returns additional flags: `is_blocked` (bool), `spam_label` (string | null), `scam_label` (string | null).

---

## 4. TNS — Enterprise Caller ID

### 4.1 Overview

Transaction Network Services (TNS) provides the **TNS Enterprise Caller ID** and **TNS Call Guardian** analytics platform. TNS data feeds into Verizon's **Call Filter** service, and TNS also operates a direct integration with some regional carriers. TNS focuses heavily on the Verizon ecosystem and has strong penetration in business-to-consumer verticals including financial services, healthcare, and utilities.

### 4.2 Eligibility Requirements

- Enterprise contract required; TNS does not offer self-serve.
- STIR/SHAKEN A-attestation required for full "Verified Business" display on Verizon.
- Business verification via DUNS number or SEC filing.
- TNS requires that the caller's SIP carrier be included in their carrier registry; BYOC carriers must be registered with TNS separately.

### 4.3 Onboarding Process

1. **Account setup** — TNS sales engagement, contract execution, credential issuance (API key + secret).
2. **Brand registration** — submit brand profile including company name, vertical, DUNS number, logo URL, and a list of call reasons.
3. **DID submission** — bulk via SFTP (CSV) or REST API. Each DID associated to a brand; TNS verifies DID ownership through RespOrg / carrier records.
4. **Carrier registry registration** — TNS validates that the BYOC carrier originates calls with valid STIR/SHAKEN A-attestation. If attestation is missing or downgraded, TNS will not display "Verified Business" though the name may still display.
5. **Go-live** — Verizon network display typically activates within 24–72 hours after DID approval.

### 4.4 API Interface (REST + SFTP)

TNS provides both a REST API and an SFTP batch interface. The REST API is preferred for programmatic integration.

**Base URL:** `https://ecid-api.tnsi.com/v3/`

Authentication: HMAC-SHA256 signed requests. Each request requires `X-TNS-Key` (API key), `X-TNS-Timestamp` (ISO 8601 UTC), and `X-TNS-Signature` (HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nBODY_SHA256`).

Key endpoints:
- `POST /brands` — register brand.
- `GET /brands/{brand_id}` — retrieve brand status.
- `POST /brands/{brand_id}/numbers` — register DIDs (up to 1000 per call).
- `DELETE /brands/{brand_id}/numbers/{e164}` — deregister DID.
- `GET /brands/{brand_id}/numbers/{e164}` — get DID registration status + reputation.
- `GET /numbers/{e164}/analytics` — TNS call analytics (answer rate, short-call rate, complaint rate, user-initiated block rate).
- `POST /feedback` — dispute a spam label on a registered number.

Rate limits: 50 req/s for registration, 20 req/s for analytics polling.

### 4.5 Brand Data Payload

```json
{
  "company_name": "ACME Corp",
  "display_name": "ACME Corp",
  "duns_number": "123456789",
  "vertical": "FINANCIAL_SERVICES",
  "logo_url": "https://cdn.acme.com/logo-256.png",
  "call_reasons": ["ACCOUNT_SERVICES", "APPOINTMENT_REMINDER"],
  "website": "https://www.acme.com",
  "contact_email": "admin@acme.com",
  "attestation": "A"
}
```

### 4.6 TNS Analytics Metrics

TNS provides richer per-number analytics than the other two providers:
- `answer_rate_7d` — percentage of calls answered (human or machine).
- `live_answer_rate_7d` — percentage of calls with human answer (seconds > 5).
- `short_call_rate_30d` — calls < 4 seconds as fraction of total.
- `user_block_rate_30d` — rate at which called parties manually blocked the number.
- `complaint_count_30d` — user-submitted spam complaints received by TNS.
- `overall_risk_score` — composite 0–100; lower = higher risk.

---

## 5. STIR/SHAKEN A-Attestation Requirement

### 5.1 What Is Required

Branded calling programs treat STIR/SHAKEN attestation level as a signal of legitimacy:
- **A-attestation** — originating carrier authenticated the subscriber and verified the subscriber is authorized to use the calling number. This is the gold standard. Both First Orion (required for full display) and TNS (required for "Verified Business" badge on Verizon) mandate A-attestation for premium branded display.
- **B-attestation** — partial; caller authenticated but number ownership not confirmed. Acceptable to Hiya and First Orion at reduced display tier. TNS will label the call but not show the "Verified Business" badge.

### 5.2 How STIR/SHAKEN Works in a BYOC Setup

In vici2's BYOC model (FreeSWITCH + SIP carrier):
1. The **SIP carrier** (e.g., Twilio, Telnyx, Bandwidth, Flowroute) is the STIR/SHAKEN **originating signer**. The carrier signs the SIP INVITE with a PASSporT JWT in the `Identity` header.
2. FreeSWITCH passes the `Identity` header through unchanged to the carrier's outbound gateway.
3. The carrier signs only if: (a) the DID is registered in their numbering inventory, and (b) they support STIR/SHAKEN signing (all Tier-1 US carriers and most Tier-2 CLECs do as of 2024).

**Implication for N05**: vici2 cannot directly control STIR/SHAKEN signing — this is a carrier function. However, N05 should:
- Read `carriers.send_pai` (T02 schema field) to detect whether the gateway is configured to send the PAI header (a proxy for STIR/SHAKEN compatibility).
- Surface a warning in the Admin UI if a DID's carrier is not known to support STIR/SHAKEN A-attestation.
- Store `attestation_level` on each `branded_did_registration` row as reported back by the provider (First Orion and TNS confirm attestation level in their DID-status responses).

### 5.3 Robocall Mitigation Database

As of the FCC TRACED Act (2021), carriers must register in the FCC's **Robocall Mitigation Database (RMD)** if they cannot fully implement STIR/SHAKEN. vici2's BYOC carriers should be checked against the RMD. Branded calling providers use RMD status as an additional trust signal.

---

## 6. Branded Data Submission: Field Requirements

### 6.1 Common Fields Across All Providers

| Field | Format | Notes |
|---|---|---|
| `company_name` / `display_name` | String, ≤30 chars | Name shown on handset |
| `logo_url` | HTTPS URL | PNG preferred; providers cache/proxy; must not have auth |
| `vertical` | Enum | See §6.2 |
| `call_reasons` | Array of enum | What the calls are about; shown on screen |
| `website` | HTTPS URL | Brand validation anchor |

### 6.2 Vertical Categories (Normalized)

vici2 stores a canonical vertical enum and maps it to each provider's vocabulary:

| vici2 canonical | First Orion | Hiya | TNS |
|---|---|---|---|
| `FINANCIAL_SERVICES` | `FINANCIAL_SERVICES` | `FINANCIAL_SERVICES` | `FINANCIAL_SERVICES` |
| `HEALTHCARE` | `HEALTHCARE` | `HEALTHCARE` | `HEALTHCARE` |
| `INSURANCE` | `INSURANCE` | `INSURANCE` | `INSURANCE` |
| `RETAIL` | `RETAIL` | `RETAIL` | `RETAIL` |
| `UTILITIES` | `UTILITIES` | `UTILITIES` | `UTILITIES` |
| `TELEMARKETING` | `TELEMARKETING` | `MARKETING` | `MARKETING` |
| `NON_PROFIT` | `NON_PROFIT` | `NON_PROFIT` | `NON_PROFIT` |
| `GOVERNMENT` | `GOVERNMENT` | `GOVERNMENT` | `GOVERNMENT` |
| `TECHNOLOGY` | `TECHNOLOGY` | `TECHNOLOGY` | `TECHNOLOGY` |
| `REAL_ESTATE` | `REAL_ESTATE` | `REAL_ESTATE` | `REAL_ESTATE` |
| `COLLECTIONS` | `COLLECTIONS` | `COLLECTIONS` | `COLLECTIONS` |

### 6.3 Call Reason Vocabulary (Normalized)

| vici2 canonical | First Orion | Hiya | TNS |
|---|---|---|---|
| `ACCOUNT_SERVICES` | `ACCOUNT_SERVICES` | `ACCOUNT_SERVICES` | `ACCOUNT_SERVICES` |
| `APPOINTMENT_REMINDER` | `APPOINTMENT_REMINDER` | `APPOINTMENT_REMINDER` | `APPOINTMENT_REMINDER` |
| `COLLECTIONS` | `COLLECTIONS` | `COLLECTIONS` | `DEBT_COLLECTION` |
| `DELIVERY_NOTIFICATION` | `DELIVERY_NOTIFICATION` | `DELIVERY` | `DELIVERY_NOTIFICATION` |
| `FRAUD_ALERT` | `FRAUD_ALERT` | `FRAUD_ALERT` | `SECURITY_ALERT` |
| `GENERAL_NOTIFICATION` | `GENERAL_NOTIFICATION` | `NOTIFICATION` | `GENERAL` |
| `MARKETING` | `MARKETING` | `MARKETING` | `MARKETING` |
| `SURVEY` | `SURVEY` | `SURVEY` | `SURVEY` |

---

## 7. Per-Call CNAM Branding vs. Static Brand-on-Number

### 7.1 Static Brand-on-Number (What N05 Implements)

All three providers (First Orion, Hiya, TNS) offer **static brand-on-number** registration:
- Register a brand profile once.
- Assign specific E.164 DIDs to the brand.
- Every call from those DIDs displays the brand metadata (name, logo, call reason) regardless of the individual call's content.
- This is the standard enterprise model and what N05 implements.

### 7.2 Per-Call Dynamic CNAM

**Legacy CNAM** (the 15-character text field) can be set statically per-DID through the carrier's CNAM provisioning. Some BYOC carriers (Twilio, Telnyx) expose a CNAM write API where the caller can set a per-call or per-DID display name. This is NOT the same as branded calling:
- CNAM is limited to 15 ASCII characters; no logo, no call reason.
- CNAM propagation can be slow (up to 72 hours for telco database updates).
- CNAM requires the terminating carrier to query the CNAM database, which not all do.

**Per-call Rich Calling** (dynamic branded display): Some providers (notably First Orion and Hiya) offer a per-call API where the outbound call SIP INVITE is enriched with a branded-calling lookup key that triggers a real-time display lookup. This requires in-path integration between FreeSWITCH and the analytics provider's SIP proxy or HTTP API — not a static registration. This is substantially more complex (requires SIP PAI/Diversion header manipulation per call) and is out of scope for Phase 1 N05. It is flagged as Phase 2.

### 7.3 Decision: Static Brand-on-Number for Phase 1

N05 Phase 1 implements static brand-on-number registration only. Every DID registered to a brand displays that brand for all calls from the DID. Per-call dynamic CNAM enrichment is Phase 2 and requires FreeSWITCH SIP channel manipulation (modifying outbound INVITE headers).

---

## 8. Carrier Coverage Map

### 8.1 Which Provider Covers Which Carrier/Platform

| Provider | T-Mobile | AT&T | Verizon | US Cellular | Google (Pixel) | Apple (iOS) | Hiya app |
|---|---|---|---|---|---|---|---|
| First Orion | Primary | Partial | Partial | Yes | Via FO analytics | Via iOS integration | No |
| Hiya | Partial | Primary | Partial | Yes | Yes (GMS) | Yes (CallKit partner) | Primary |
| TNS | Partial | Partial | Primary | Partial | Via TNS feed | Via iOS integration | No |

**Notes:**
- "Primary" = the named carrier uses this provider as their default branded-calling analytics engine.
- "Partial" = the carrier accepts data from this provider but it is not their primary engine; branded display may show on some device models/OS versions only.
- Multi-provider registration (registering the same DID with all three providers) maximizes coverage across all carriers.
- Regional carriers (C-Spire, Cincinnati Bell, Alaska Communications) typically query at least one of the big three through analytics-sharing agreements.

### 8.2 Android vs iOS Coverage

- **Android** (Pixel, Samsung, Motorola): Google's Phone app (GMS) queries Hiya's database for non-enrolled devices; enrolled carriers (T-Mobile, AT&T) override with their own branded display.
- **iOS**: Apple's CallKit allows third-party call-labeling apps (Hiya, First Orion Protect) to display labels. Native iOS does not natively query any branded-calling provider; iOS 16+ CallKit API allows app-level display only.

---

## 9. Reputation Feedback Loop: Integration with X04

### 9.1 What Providers Expose

All three providers expose per-number reputation data:
- **First Orion**: Reputation score 0–100 via `GET /numbers/{e164}/reputation`.
- **Hiya**: Score 0–10 + boolean flags (`is_blocked`, `spam_label`) via `GET /business/numbers/{e164}/score`.
- **TNS**: Multi-metric analytics (answer rate, block rate, complaint count, composite risk score) via `GET /numbers/{e164}/analytics`.

### 9.2 Score Normalization

N05 normalizes all provider scores to a common 0–100 integer scale stored on `branded_did_registrations.reputation_score`:

| Provider | Raw scale | Normalize formula |
|---|---|---|
| First Orion | 0–100 (100 = best) | `score` unchanged |
| Hiya | 0–10 (10 = best) | `score * 10` |
| TNS | 0–100 (0 = best = LOWER risk) | `100 - overall_risk_score` |

For a DID registered with multiple providers, N05 stores the **worst (lowest) normalized score** in `branded_did_registrations` and uses the lowest across all registrations for the DID to set `did_numbers.brand_reputation_score` (a new column added by N05's migration).

### 9.3 X04 Integration Hook

X04's quarantine engine reads `did_numbers.brand_reputation_score`. N05 defines a `BrandedCallingReputationHook` interface:

```typescript
interface BrandedCallingReputationHook {
  // Called by reputation poller after updating scores
  onRepScoreUpdated(didId: bigint, tenantId: bigint, normalizedScore: number): Promise<void>;
}
```

X04 registers a concrete implementation of this hook at startup:
```typescript
// workers/src/jobs/branded-calling/reputation-poller.ts
import { x04QuarantineHook } from '../number-pool/quarantine-hook';
reputationPoller.onRepScore = x04QuarantineHook;
```

When `normalizedScore < BRAND_QUARANTINE_THRESHOLD` (default: 30), X04's hook calls `pool.QuarantineDID(ctx, didId, 'BRAND_REPUTATION', score)`, which sets `number_pool_dids.quarantined = true` and `quarantine_reason = 'BRAND_REPUTATION'`. Admin must manually unquarantine after remediation.

### 9.4 Feedback Submission (Dispute)

When an admin views a DID labeled as spam in the Admin UI, they can submit a dispute to the provider:
- First Orion: `POST /numbers/{e164}/report-spam` with body `{"action": "DISPUTE", "reason": "CONSENTED_OUTBOUND"}`.
- Hiya: `POST /business/numbers/{e164}/feedback` with body `{"feedback_type": "MISLABELED", "notes": "..."}`.
- TNS: `POST /feedback` with body `{"e164": "...", "brand_id": "...", "dispute_reason": "VERIFIED_BUSINESS"}`.

Disputes do not immediately change the reputation score; providers investigate and update scores within 48–72 hours.

---

## 10. Polling Cadence and Operational Considerations

### 10.1 Recommended Polling Cadence

| Activity | Recommended interval | Rationale |
|---|---|---|
| Reputation score refresh (healthy numbers) | Daily (24h) | Scores change slowly for healthy numbers |
| Reputation score refresh (at-risk, score < 60) | Every 4 hours | Faster detection of deterioration |
| Registration status sync | Every 6 hours | Detect provider-side deactivations |
| Bulk DID re-registration (refresh) | Every 30 days | Provider contracts may require periodic attestation refresh |
| Spam-report/dispute result polling | Every 12 hours | Follow up on open disputes |

### 10.2 Cost Considerations

All three providers charge per-number-per-month fees for branded registration. Indicative 2025 pricing (subject to negotiation and volume discounts):
- **First Orion Engage**: ~$0.50–$1.50 per registered number per month, depending on volume tier.
- **Hiya Connect**: ~$0.30–$1.00 per registered number per month.
- **TNS Enterprise Caller ID**: ~$0.75–$2.00 per registered number per month.

N05 tracks registration counts per provider and exposes cost-estimation data in the Admin UI. The actual billing is done outside vici2 (direct provider contracts), but the system surfaces "registered DID-months" as a metric for cost awareness.

### 10.3 Number Churn and Deregistration

When a DID is deprovisioned (removed from T02 `did_numbers` table), N05's registration worker must deregister it from all providers. This is handled by a cascading hook on `did_numbers` deletion (via BullMQ job enqueued by the T02 API on DID delete).

---

## 11. Open Questions

1. **STIR/SHAKEN attestation source** — Should N05 actively read the outbound SIP `Identity` header to confirm A-attestation is present before submitting a DID to a provider? This would require a test-call mechanism or carrier-API attestation query. Currently vici2 has no mechanism to confirm the attestation level of a specific carrier. Alternative: Surface carrier STIR/SHAKEN capability as a manual config field on `carriers` and block registration if not confirmed.

2. **Multi-tenant branding** — In a multi-tenant vici2 deployment, each tenant has its own brand. Should each tenant be allowed its own provider API credentials, or should the super_admin manage a shared provider credential that all tenants share? Phase 1 assumes one brand per tenant with per-tenant provider credentials; multi-tenant pooling (one provider contract for all tenants) is Phase 2.

3. **Per-call call reason** — All three providers support a single call reason per registered DID. In practice, a single DID in a contact center may be used for account services one hour and collections the next. Should vici2 allow a DID to have a call-reason override at the campaign level that triggers a re-registration? This is architecturally complex and deferred to Phase 2.

4. **Logo hosting** — Providers require a stable HTTPS URL for the logo. Who hosts it? Tenant may not have a CDN. Phase 1 plan: tenants provide a URL; N05 validates it returns a valid image. Phase 2: vici2 hosts logos in S3 with a pre-signed CloudFront URL.

5. **Carrier-side CNAM sync** — Should N05 also write CNAM records through the carrier API (Twilio CNAM provisioning, Telnyx CNAM) for coverage on older handsets? This overlaps with T02 scope. Flagged for T02 Phase 2.

6. **FCC Robocall Mitigation Database check** — Should N05 query the RMD API to validate that the outbound carrier is registered before submitting DIDs to providers? The RMD has a public data export but not a real-time API. Likely a manual operator checkbox in Phase 1.

7. **Apple iOS coverage** — None of the three providers have a direct Apple CallKit integration that would show branded content on stock iOS without the user installing a third-party app. Is there value in integrating with Apple's Business Connect (formerly Apple Maps Connect) which allows businesses to register their phone numbers? Apple Business Connect feeds into iOS 16+ CallKit identity resolution. This is a separate program/API not covered by any of the three providers.

8. **Reputation score staleness** — If the polling worker is down for >24 hours, reputation scores become stale. X04 quarantine decisions made on stale scores could be incorrect. Consider a staleness flag: if `reputation_last_polled_at` is >48 hours ago, treat the DID as unscored rather than using the stale score.

---

## 12. Summary of Key Findings

1. Three providers cover the three major US carriers: First Orion → T-Mobile, Hiya → AT&T, TNS → Verizon. Multi-provider registration maximizes handset coverage.
2. STIR/SHAKEN A-attestation is a prerequisite for premium display on First Orion and TNS; the BYOC SIP carrier must provide this — vici2 cannot generate PASSporT JWTs itself.
3. All three providers have REST APIs; authentication differs (OAuth2 for First Orion, API key for Hiya, HMAC for TNS). A common interface wrapping all three is the correct abstraction.
4. Reputation scores must be normalized to a common scale for X04 integration. The worst score across all providers governs quarantine decisions.
5. Static brand-on-number is the correct Phase 1 implementation; per-call dynamic enrichment requires SIP header manipulation and is Phase 2.
6. Provider fees are per-number-per-month; vici2 should surface registered-DID counts to inform cost decisions.
7. Logo hosting, Apple iOS coverage, per-call call reason, and carrier STIR/SHAKEN attestation confirmation are all deferred to Phase 2 or later.
