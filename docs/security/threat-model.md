# vici2 Threat Model — STRIDE per Component

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Owner:** Security / O05
**Related:** O05 PLAN §5, RESEARCH §6; F03 PLAN (FS), F05 PLAN (auth/KEK), A01 PLAN (agent UI)

---

## Trust Boundary Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│  UNTRUSTED                                                                  │
│  ┌────────────┐         SIPS:5061 + SRTP                                    │
│  │  Carrier   │─────────────────────────────────►┌──────────────────────┐  │
│  └────────────┘                                  │  FreeSWITCH external │  │
│                                                  │  profile (IP-ACL +   │  │
│                                                  │  per-gw register)    │  │
│                                                  └──────────┬───────────┘  │
│                                                             │              │
│  ┌────────────┐  WSS:7443 + DTLS-SRTP    ┌─────────┐        │              │
│  │  Browser   │─────────────────────────►│  Caddy  │────────┤              │
│  │ (agent UI) │  HTTPS:443 + JWT cookie  └────┬────┘        │              │
│  └────────────┘                               │             │              │
│                                               │             │              │
└───────────────────────────────────────────────┼─────────────┼──────────────┘
   SEMI-TRUSTED (JWT-authenticated)             │             │
                                                │             │
┌───────────────────────────────────────────────┼─────────────┼──────────────┐
│  TRUSTED (docker internal networks)           ▼             ▼              │
│                                          ┌────────┐    ┌──────────────┐    │
│                                          │  api   │    │  FS internal │    │
│                                          │ :3000  │    │  + WSS       │    │
│                                          └───┬────┘    └──────┬───────┘    │
│                                              │                │            │
│                                              ▼                ▼            │
│  ┌─────────┐                            ┌────────┐      ┌──────────┐       │
│  │ dialer  │◄───────ESL:8021────────────│ valkey │◄─────│ workers  │       │
│  └────┬────┘                            └────────┘      └──────────┘       │
│       │                                      ▲                             │
│       └──────────► mysql (no host port) ◄────┘                             │
│                                                                            │
│  PRIVILEGED (admin)                                                        │
│  ┌────────────┐  HTTPS:443 + JWT(role=admin) + TOTP (F06/Phase 2)          │
│  │  Admin UI  │──────────────────────────────────────────► api / mysql     │
│  └────────────┘  (every mutation → audit_event row)                        │
└────────────────────────────────────────────────────────────────────────────┘
```

### Trust Boundaries Summary

| Boundary | Classification | Protocol | Auth |
|---|---|---|---|
| Carrier → FS external profile | **Untrusted** | SIPS:5061 + SRTP | IP-ACL + SIP digest per-gateway |
| Browser → Caddy | **Semi-trusted** | WSS:7443 + HTTPS:443 | JWT httpOnly cookie |
| Caddy → api/web | **Trusted (edge network)** | HTTP | Bearer JWT forwarded |
| api/dialer → MySQL | **Trusted (data network)** | MySQL protocol | Per-service credentials |
| api/dialer → Valkey | **Trusted (data network)** | RESP | ACL per-service user |
| dialer → FS ESL | **Trusted (core network)** | TCP:8021 | Password |
| Admin → api | **Privileged** | HTTPS:443 | JWT role=admin + TOTP (Phase 2) |

---

## 1. FreeSWITCH

**Mitigations owned by:** F03 PLAN §2 (3-profile design), §10 (recording template)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Carrier impersonation; unauthenticated calls entering dialplan | IP-ACL on `external` Sofia profile; SIP digest auth on per-carrier gateway row; `<context name="public">` rejects ACL-misses | F03 PLAN (implemented) |
| **S** Spoof | REGISTER flood to steal extension IDs | fail2ban `freeswitch-dos` jail (50/60s → 24h ban); iptables hashlimit 5 REGISTER/s per srcIP | O05 (this module) |
| **T** Tamper | Modify SDP / hijack RTP stream | SRTP mandatory; `rtp_secure_media` enforced on internal profile; DTLS-SRTP for WebRTC leg; `apply-candidate-acl` restricts ICE origins | F03 PLAN |
| **R** Repudiate | Caller denies making call | `call_log` row + consent-prompt recording + CDR CSV | F03/R02 PLAN |
| **I** Info-disclose | RTP eavesdrop (passive attacker on same LAN) | SRTP mandatory on all media; recordings SSE-KMS at rest | F03, O05 §10 |
| **I** Info-disclose | FS logs contain SIP credentials | `log-auth-failures` logs only failure events, not passwords; F03 PLAN never logs SIP digest | F03 PLAN |
| **D** DoS | SRTP packet flood (ES2021-09 CVE — fixed ≥1.10.7) | Pin FS ≥ 1.10.12; iptables hashlimit pre-filters packets | O05 + F03 image pin |
| **D** DoS | DTLS Hello race-condition (ES2023-02 — fixed later 1.10.x) | Pin FS ≥ 1.10.12 | F03 image pin |
| **D** DoS | INVITE flood | iptables hashlimit; fail2ban `freeswitch-dos` | O05 |
| **E** Elevate priv | ESL command injection via dialplan / Lua | ESL bound to `127.0.0.1:8021` on docker `core` net only; password-auth required; never interpolate caller-ID into dialplan unsanitized | F03 PLAN |

---

## 2. Backend API (Node 20 + Fastify)

**Mitigations owned by:** F05 PLAN §1 (JWT), §2 (refresh-rotation), §6 (RBAC)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Stolen JWT; session fixation | Short-TTL JWT (15min access) + refresh-rotation; `httpOnly secure sameSite=Strict` cookies; CSRF token on state-changing endpoints | F05 PLAN |
| **S** Spoof | Token replay after logout | Refresh token stored in Valkey; revoked on logout by deleting the key | F05 PLAN |
| **T** Tamper | Tampered request body bypasses validation | Fastify JSON schema validation on every route; OpenAPI-generated types; no raw user JSON.parse | F01/F05 PLAN |
| **T** Tamper | JWT claim manipulation (`role`, `tenant_id`) | JWT signed with EdDSA private key (F05 PLAN §1); claim enum-validated server-side per request | F05 PLAN |
| **R** Repudiate | Disposition write without audit trace | Every dispo write → immutable `audit_event` row (F02 PLAN) | F02 PLAN |
| **I** Info-disclose | SQL injection | Prisma parameterized queries only; no raw `$queryRaw` with user input | F01/F05 PLAN |
| **I** Info-disclose | XSS via API response | Caddy CSP header on all responses; React auto-escapes | O05 (CSP) |
| **I** Info-disclose | KEK/DEK exposure in logs | F05 encryption.ts never logs key material; audit_event payload JSON-serialized without key fields | F05 PLAN |
| **D** DoS | API request flood / login spray | Caddy rate-limit per `remote_host`; fail2ban `caddy-auth` (10/5min → 30min ban) | O05 |
| **E** Elevate priv | JWT role claim escalation by user | Role claim validated against DB `users.role` on JWT mint only; not trusted for privilege decisions mid-session beyond initial mint | F05 PLAN §6 |

---

## 3. Agent UI (Next.js + SIP.js browser)

**Mitigations owned by:** A01 PLAN (CSP/SRI), F05 PLAN §5.4 (one-time SIP creds)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Hijack SIP.js registration with stolen SIP creds | SIP creds delivered via JWT-authenticated `/api/agent/sip-creds` (one-time, 5-min TTL); per-agent SIP password auto-rotated weekly | F05 PLAN §5.4 |
| **T** Tamper | DOM-injected scripts alter call flow | Strict CSP (`default-src 'self'; connect-src 'self' wss://*.vici2.example.com`); no `unsafe-eval`, no `unsafe-inline` in script-src; SRI on all third-party JS | O05 (CSP header) |
| **T** Tamper | CSRF on state-changing API calls | `sameSite=Strict` cookie + CSRF token on non-idempotent endpoints | F05 PLAN |
| **R** Repudiate | "I never dispo'd that lead" | Dispo write hits server → `audit_event` row immediately | F02 PLAN |
| **I** Info-disclose | Page leaks lead PII into browser telemetry | No third-party analytics on agent UI; no Sentry user_id mapping to lead phone | A01 PLAN |
| **I** Info-disclose | DTLS-SRTP fingerprint from self-signed cert enables MITM | Must use publicly-trusted LE cert for DTLS — Chrome/Firefox reject self-signed DTLS (RESEARCH §2.5) | O05 (certbot) |
| **D** DoS | Rage-click DoS on "Dial" button | Client-side debounce + server-side idempotency key on `/api/agent/dial` | A02/F05 PLAN |
| **E** Elevate priv | Agent self-promotes to supervisor via DevTools | Role enforced server-side per request; UI hiding is cosmetic only | F05 PLAN §6 |

---

## 4. Admin UI

**Mitigations owned by:** A04 PLAN (admin), F06 PLAN (MFA — Phase 2)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Stolen admin JWT enables unrestricted access | MFA mandatory in Phase 2 (TOTP via F06); Phase 1 workaround: ops-jump-host allowlist + JWT 15min TTL + audit-everything pattern | Phase 1: partial; Phase 2: F06 |
| **S** Spoof | Admin session fixation / cookie theft | Same JWT protections as API; `secure httpOnly sameSite=Strict` | F05 PLAN |
| **T** Tamper | Carrier-config tamper to enable toll fraud | Every `carrier_gateway` UPDATE → `audit_event` + Slack/PagerDuty webhook (`admin.config.changed`) | F05/T02 PLAN |
| **T** Tamper | Schema injection via admin filter inputs | Prisma only; no dynamic ORDER BY without explicit allow-list; no raw queries | F05 PLAN |
| **R** Repudiate | Audit-log gaps (admin deletes own audit rows) | `audit_event` table: INSERT only for `vici2_app` user; no DELETE/UPDATE granted | F02 PLAN |
| **I** Info-disclose | Lead-list export by unauthorized admin | Export guarded by `role=admin+export` claim; export emits `audit_event` row + short-TTL signed download URL | A04/F05 PLAN |
| **I** Info-disclose | Admin UI accessible from internet without MFA | Phase 1: network-level (ops-jump-host allowlist via fail2ban ignoreip); Phase 2: VPN/mTLS before TOTP | TODO: Phase 2 (F06) |
| **D** DoS | Admin endpoint flood | Same Caddy rate-limit as API | O05 |
| **E** Elevate priv | Regular agent reaches admin UI via URL manipulation | Admin routes require JWT `role` ∈ {admin, super_admin}; checked per-request server-side | F05 PLAN §6 |

---

## 5. MySQL

**Mitigations owned by:** F02 PLAN (per-service users, schema), R03 PLAN (backup encryption)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Direct DB access from outside docker network | Bound to docker `data` internal network; no `ports:` in prod compose (`expose:` only) | O05 compose hardening |
| **S** Spoof | Attacker guesses DB credentials | Per-service MySQL users with minimum grants (F02 PLAN); long random passwords; never root in app connections | F02 PLAN |
| **T** Tamper | Schema drift from raw ALTER statements | SPEC §3.8: Prisma migrations only; `migrator_ddl` is the only user allowed DDL | F02 PLAN |
| **T** Tamper | Audit row modification | `audit_event` table: no UPDATE/DELETE granted to any app user; INSERT only | F02 PLAN |
| **R** Repudiate | Recording tampered post-recording | S3 Object Lock COMPLIANCE mode, 4-year retention; after S3 PUT, local file unlinked | O05 §10, R03 PLAN |
| **I** Info-disclose | Backup leakage | Dumps encrypted with separate backup KEK (not app KEK); stored in S3 SSE-KMS | O02/R03 PLAN |
| **I** Info-disclose | Column data at rest unencrypted | Sensitive columns (SIP creds, carrier creds, TOTP seeds) use F05 envelope encryption (AES-GCM-256 + per-row DEK + KEK) | F05 PLAN |
| **D** DoS | Connection exhaustion | `pool_size` tuned per service (F02 PLAN); `wait_timeout` configured in `infra/mysql/my.cnf` | F02 PLAN |
| **E** Elevate priv | App user executes DDL | Per-service MySQL users have minimum grants; `vici2_app` does NOT have CREATE/DROP/ALTER | F02 PLAN |

---

## 6. Valkey (Redis-compatible)

**Mitigations owned by:** F04 PLAN (ACL per-service users), F05 PLAN §2 (refresh tokens)

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| **S** Spoof | Unauthenticated Valkey access | `requirepass` + ACL per-service user (api_rw, dialer_rw, observer_ro); bound to docker `data` internal network | F04 PLAN |
| **S** Spoof | Attacker on docker network spoofs another service | ACL restricts commands per user; observer_ro is read-only | F04 PLAN |
| **T** Tamper | Agent state manipulation (mark agent ready when not) | Streams append-only; no SET on agent state from outside `dialer` / `api` (enforced via ACL command restrictions) | F04 PLAN |
| **T** Tamper | Refresh token substitution | Refresh token stored with TTL; JWT jti claim validated server-side against Valkey entry; rotation on each use | F05 PLAN §2 |
| **R** Repudiate | Volatile store — no persistence for audit | Valkey is NOT the audit source; all audit records go to MySQL `audit_event`; Valkey is ephemeral session state only | F02/F05 PLAN |
| **I** Info-disclose | Sniff Valkey state on docker network | No TLS on docker internal network in Phase 1 (multi-host migration deferred to Phase 2); network-isolated | TODO: Phase 2 (TLS on Valkey) |
| **D** DoS | OOM via key bloat / large stream accumulation | `maxmemory-policy allkeys-lru`; alert at 70% usage (O01); stream trimming in workers | F04/O01 PLAN |
| **E** Elevate priv | Lua script injection via EVAL from app | All Lua scripts compiled and registered via `SCRIPT LOAD`/`EVALSHA`; no user-string-interpolated EVAL | F04 PLAN |

---

## Open Mitigations (items without a module owner)

| Component | STRIDE | Threat | Target Phase | Action |
|---|---|---|---|---|
| Admin UI | **S** Spoof | No MFA in Phase 1 | Phase 2 | F06 PLAN must implement TOTP for `role=admin`; F07 for WebAuthn |
| Valkey | **I** Info-disclose | No TLS on docker internal network | Phase 2 | Enable Valkey TLS when migrating to multi-host / k8s |
| audit_event | **R** Repudiate | No hash-chain for append-only guarantee | Phase 2 | F02 hardening: add `prev_hash` chain column |
| All services | **I** Info-disclose | No SOC 2 Type II audit | Phase 4 | Required before healthcare/financial GA customers |
| FS / Caddy | **D** DoS | DDoS at ISP level (volumetric) | Phase 4 | AWS Shield / Cloudflare DDoS protection at network edge |

---

## Security Header Policy (Caddy-injected)

All HTTPS responses from Caddy carry the following security headers. See
`infra/caddy/Caddyfile.example` for the exact header directive.

| Header | Value | Rationale |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 2-year HSTS; preload registration eligible |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing attacks |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Minimal referer leakage |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(self), payment=()` | `microphone=(self)` required for WebRTC |
| `Content-Security-Policy` | (see Caddyfile) | Strict CSP; `unsafe-eval` explicitly excluded |
| `Cross-Origin-Opener-Policy` | `same-origin` | Spectre isolation |
| `Cross-Origin-Embedder-Policy` | `require-corp` | Required for SharedArrayBuffer (WebRTC) |
