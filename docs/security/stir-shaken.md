# STIR/SHAKEN — Phase 2 Doc-Only

**Status:** Phase 2+ deferred. No implementation required in Phase 1.
**Owner:** O05 (security baseline documentation)
**Date:** 2026-05-13

---

## Phase 1 Position: No Signing Required

Per FCC's Eighth Report and Order (effective 2025-09-18):

vici2 is **not a Voice Service Provider (VSP)** with a STIR/SHAKEN
implementation obligation. Our carriers — Twilio, Telnyx, Bandwidth,
SignalWire, Flowroute — are the VSPs and sign calls with their own SPC-token-
issued certs at A-attestation for numbers they own or have delegated
attestation for.

**Phase 1 action: none.** No STIR/SHAKEN cert handling is built or needed.

---

## When Phase 2 Kicks In

STIR/SHAKEN implementation becomes required for vici2 if either:

1. **vici2 becomes a CLEC** / obtains direct carrier interconnects (DESIGN
   §14.3 currently says we don't). At that point, FCC requires signing with
   an SPC token issued for our OCN.
2. **We offer Hosted Signing as a product feature** — customers who are VSPs
   want vici2 to perform PASSporT signing on their behalf (Bandwidth-style
   Hosted Signing Service). This is a Phase 4+ revenue lever.

---

## What Phase 2 Requires

### Certificates and Authority

1. **SPC (Service Provider Code) token** from STI-PA (Policy Administrator):
   - Apply at [authenticate.iconectiv.com](https://authenticate.iconectiv.com)
   - Requires FCC Form 499 filer ID or OCN (Operating Company Number)
   - RMD recertification deadline: 2026-03-01 (update annually)

2. **STI-CA digital certificate** issued using the SPC token:
   - ASN.1 extension OID `1.3.6.1.5.5.7.1.26` MUST be present
   - Short-lived cert (90 days typical) — separate lifecycle from LE/ACME certs
   - Requires a different automation path (not certbot/Caddy)

3. **Public cert distribution**: upload public cert to an S3-hosted URL so
   terminating carriers can fetch it for verification.

### Technical Integration

4. **PASSporT signing** integrated into FreeSWITCH dialplan:
   - Option A: `mod_signalwire`'s `stirshaken_sign_da` API (if on SignalWire cloud)
   - Option B: Custom Lua + `sti-go` library
   - Option C: Standalone PASSporT microservice called from dialplan via HTTP

5. **Per-call attestation logic** (A/B/C):
   - A-attestation: we fully know the caller identity and authorized the call
   - B-attestation: we partially know (e.g., subscriber-provided number, not verified)
   - C-attestation: we pass through from another carrier
   - Decision tree must be implemented by us; third-party Hosted Signing does the crypto only

6. **Cert lifecycle automation**: separate from LE certs — needs its own renewal pipeline and monitoring.

### Governance

7. **Third-party signing agreement**: if using Hosted Signing, FCC may audit the agreement.
8. **Recordkeeping**: maintain records of attestation decisions per call for regulatory audit.

---

## Phase 2 Deferred Decisions

| Decision | Notes |
|---|---|
| Build PASSporT signing in FS vs. use Hosted Signing vendor | Hosted Signing is cheaper to start (no cert management); in-FS is required if we become CLEC |
| Which STI-CA to use | SHAKEN Cert Authority list published by ATIS; consider Comcast, Sansay, others |
| Per-call A/B/C decision tree | Depends on number ownership model (ported? assigned? outbound-only?) |
| RMD recertification process | Annual; set calendar reminder 60d before deadline |

---

## Compliance Reference

- FCC Eighth Report and Order: 90 FR 158 (2025-08-19)
- FCC DOC-421205A1: STIR/SHAKEN governance system
- ATIS-1000074 (SHAKEN baseline): PASSporT signing framework
- RMD (Robocall Mitigation Database): mandatory registration, annual recertification
