# F05 — Auth + RBAC + SIP Credential Storage — RESEARCH

**Module:** F05
**Phase:** RESEARCH (PLAN/IMPL blocked on F02)
**Date:** 2026-05-06
**Status:** Research only — no code, no PLAN

---

## 1. Executive summary (10 bullets)

1. **JWT signing — recommend EdDSA (Ed25519)** for new code. 32-byte keys, 64-byte signatures, deterministic, side-channel-safe (RFC 8032/8037). Falls back to **RS256** only if a downstream consumer (legacy SDK, hardware token, picky API gateway) refuses OKP keys. **HS256 (shared-secret) is rejected** for vici2 because the dialer (Go) and api (Node) need to verify JWTs they didn't sign — asymmetric is the cleaner trust boundary.
2. **Token lifetimes — access 15 min, refresh 30 days, sliding.** Aligns with OWASP/Auth0/Okta industry consensus. Refresh tokens are **opaque random 256-bit IDs stored in Redis** (not self-contained JWTs) so revocation is O(1). Rotated on every use with reuse-detection and **family-tracked revocation** (Auth0 RTR pattern). Access tokens carry `uid`, `tid` (tenant), `role`, `iat`, `exp`, `jti`, `iss`, `aud`.
3. **Refresh-token reuse → revoke entire family.** Each login starts a "family" (`family_id` UUID). Rotating a refresh token issues a new one in the same family and marks the prior token used. If a token marked "used" or "revoked" is presented, **all tokens in that family are revoked** and the user is forced to re-authenticate. Captured in audit log as `auth.refresh_reuse_detected`. Backed by RFC 9700 / OWASP ASVS 51.2.4.
4. **Argon2id parameters (OWASP 2026):** baseline **m=19456 KiB (19 MiB), t=2, p=1**, with **calibration step at install time** to find the largest `m` that completes in ≤500 ms on the target server. Document chosen params in `auth.config.argon2`. Re-hash on login if the stored hash's params are below the current floor. Never go below the OWASP minimum row.
5. **Password policy — NIST SP 800-63B-aligned:** minimum 12 characters (we exceed NIST's 8-char floor for SOC 2 readiness; SOC 2 / NIST Rev 4 push 15 for single-factor accounts), no composition rules, no forced rotation, **breached-password check via HIBP k-anonymity range API** (`/range/{first 5 SHA-1 chars}`) on signup and password change. Bundle the offline NTLM/SHA-1 download for air-gapped deployments.
6. **AES-GCM-256 envelope encryption for SIP/carrier credentials at rest.** **KEK** lives in env (Phase 1) → **HashiCorp Vault Transit or AWS KMS** (Phase 4). **DEK** is a per-record 256-bit random key, encrypted with KEK and stored alongside the ciphertext. **AAD = `sha256(record_table || ":" || record_id || ":" || tenant_id)`** binds ciphertext to its row, preventing swap attacks. Random 96-bit IV per encrypt; never reused.
7. **SIP credentials served to FreeSWITCH via mod_xml_curl on loopback.** Phase 1 spec calls for static-XML render-on-update; this RESEARCH recommends adding a **runtime mod_xml_curl directory binding** (post-MVP) so credentials never touch disk. FS `directory` request → API hits internal endpoint (loopback only, no JWT, IP-allowlist 127.0.0.1) → API decrypts DEK → returns directory XML with cleartext password. For Phase 1 we accept the static-XML compromise documented in F05.md but flag it as a hardening item.
8. **RBAC model:** five roles — `super_admin > admin > supervisor > agent`, plus `integrator` (machine-to-machine, no UI). Permissions as **action verbs scoped to resources**: e.g. `lead:edit`, `call:transfer`, `recording:download`, `campaign:edit`, `dnc:bypass`, `audit:view`, `user:rotate-sip`. **All permission checks are tenant-scoped** — every authorized resource must satisfy `resource.tenant_id == jwt.tid` (enforced in middleware, not handlers). Role→permissions mapping is a static in-code matrix (not DB-driven) for Phase 1; DB-driven custom roles are deferred to Phase 4.
9. **WebSocket auth:** access token passed via **`Sec-WebSocket-Protocol` subprotocol header** (`Sec-WebSocket-Protocol: vici2.jwt.<token>`). Avoid query-string tokens (logged in proxies). Re-validate JWT on `preValidation` hook in `@fastify/websocket`. On token expiry, server sends `{type:'token_expiring'}` 2 min early so the client refreshes; on `reauth` message we verify the new access token and continue the same socket. Browser-side SIP.js auth still uses SIP digest with `sip_password` over WSS — independent path.
10. **Audit log integration is mandatory.** Every privileged auth event (login.ok, login.fail, logout, refresh.ok, refresh.reuse, password.change, sip.rotate, role.change, user.create, kek.rotate) writes a row via the F02-provided `audit_events` table inside the same transaction as the action (per DESIGN.md §4.7 / SPEC.md §C03). Log row carries `actor_user_id`, `tenant_id`, `action`, `resource_type`, `resource_id`, `ip`, `user_agent`, `outcome`, `ts`, plus action-specific `details` JSON. **No secrets ever go in the log** (verified in CI by grep step listed in F05.md acceptance criteria).

---

## 2. JWT design (algorithm, lifetimes, rotation)

### 2.1 Algorithm choice

| Algo | Sig size | Key size | Speed (verify) | Notes |
|---|---|---|---|---|
| **EdDSA (Ed25519)** | 64 B | 32 B | ~30k/s | Deterministic, no RNG dependency, side-channel safe (RFC 8032). RECOMMENDED. |
| RS256 | 256 B (2048-bit) | 256 B + | ~5k/s | Universal compatibility. Larger headers. Acceptable fallback. |
| ES256 | 64 B | 32 B | ~10k/s | RNG-dependent (signature failures on weak entropy → key recovery). Avoid unless EdDSA unavailable. |
| HS256 | 32 B | 32 B (shared) | ~50k/s | Symmetric — both API and dialer would share the secret. Trust-boundary problem: rejected. |

**Recommendation:** EdDSA primary, RS256 documented fallback.

`@fastify/jwt` uses `fast-jwt` underneath, which supports EdDSA via `jose` interop. Go's `golang-jwt/jwt/v5` and `github.com/lestrrat-go/jwx/v2` both support EdDSA — confirms cross-language verifiability.

### 2.2 Key management

- **Signing key generated once at install** (`scripts/gen-jwt-keys.sh`); private PEM in env (`JWT_SIGNING_KEY_ED25519`), public PEM in `JWT_PUBLIC_KEY_ED25519`.
- **Key rotation:** dual-key publication via JWKS endpoint (`/.well-known/jwks.json`) with `kid` header. New JWTs signed by `kid=2`; old `kid=1` accepted until all live tokens expire (≤30 d for refresh + ≤15 m for access).
- **Verification cache:** JWKS cached 1 week in Node (`fastify-jwt-jwks` pattern); Go dialer rotates via SIGHUP or fixed 1-min TTL.

### 2.3 Token shape

```jsonc
// Access token (JWT, 15 min)
{
  "iss": "vici2-api",
  "aud": ["vici2-api", "vici2-dialer"],
  "sub": "u_42",            // user_id
  "uid": 42,
  "tid": 1,                 // tenant_id
  "role": "agent",
  "perms": ["lead:edit","call:transfer", ...],  // optional inline perms; trim if too large
  "iat": 1746500000,
  "exp": 1746500900,        // +15 min
  "jti": "uuid-v4",
  "kid": "ed25519-2026-1"
}
```

Refresh token = opaque 256-bit base64url string, **not** a JWT. Stored in Redis at `t:{tid}:auth:refresh:{token_id}` with value JSON `{user_id, family_id, issued_at, used:false, expires_at}`. TTL = 30 days, sliding (each rotation extends by 30 days from refresh time).

### 2.4 Rotation + reuse detection

State machine per refresh token:
```
ISSUED → (presented in /auth/refresh) → CONSUMED (atomic SET-NX) → new token issued in same family
ISSUED → (token expired) → EXPIRED
CONSUMED → (presented again) → REUSE_DETECTED → revoke entire family → audit
REVOKED → (presented) → 401 + audit
```

Implementation note: the "atomic consume" is a Lua script in Redis to avoid TOCTOU. Auth0 RTR and Okta both implement this pattern; OWASP ASVS 51.2.4 requires reuse-triggered revocation for L1. **30-second grace window** (Okta default) optional for poor-network clients but increases attack surface; we recommend **0-second grace for Phase 1** and revisiting if mobile clients arrive.

### 2.5 Lifetimes

| Audience | Access | Refresh | Idle | Absolute |
|---|---|---|---|---|
| Browser (agent UI) | 15 min | 30 d | 30 min sliding | 30 d |
| Browser (admin/sup) | 15 min | 7 d | 30 min sliding | 7 d (sensitive) |
| Integrator (M2M) | 60 min | n/a | n/a | scoped per-API-key |

Absolute caps satisfy OWASP "no infinite session" guidance and SOC 2 logical-access controls.

---

## 3. Password hashing parameters

### 3.1 Algorithm: argon2id (RFC 9106)

OWASP 2026 cheat sheet recommends one of these equivalent rows:

| Row | m (KiB) | m (MiB) | t | p | Notes |
|---|---|---|---|---|---|
| A | 47104 | 46 | 1 | 1 | recommended baseline |
| B | 19456 | 19 | 2 | 1 | **OWASP min** for 2026 |
| C | 12288 | 12 | 3 | 1 | memory-constrained |
| D | 9216  | 9  | 4 | 1 | further constrained |
| E | 7168  | 7  | 5 | 1 | absolute floor |

`node-argon2` defaults are now Row-B-like (PR #360 adopted RFC 9106 SECOND RECOMMENDED). RFC 9106's FIRST RECOMMENDED (m=2 GiB, t=1, p=4) is impractical for Node V8 (heap pressure) and Vicidial-scale concurrent logins.

### 3.2 Calibration

At install / on `npm run calibrate`, run a benchmark that increases `m` until a single hash takes 250–500 ms on the target hardware (OWASP guidance: "as much memory as you can afford while still authenticating users in <500 ms"). Persist chosen `(m, t, p)` to `auth_config` table; new hashes use those; on login, if stored hash params < current params, re-hash silently.

### 3.3 Salt + tag

- Salt: 128 bits, random, embedded in PHC string.
- Tag: 256 bits.
- Encoding: PHC string (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`) — what `node-argon2` produces by default.

### 3.4 Pepper (optional, deferred)

OWASP supports an HMAC pepper applied **before** argon2id, with the pepper key stored in env (not DB). Adds another factor an attacker needs even with full DB compromise. **Recommendation:** add a pepper from day 1 — it's one HMAC; rotation is harder (forces all-user re-hash on next login), so document trade-off in PLAN.

### 3.5 Password policy

Per NIST SP 800-63B Rev 4 + OWASP A07:2025:

- Min length: **12 chars** (NIST allows 8 with MFA, 15 without; we sit in middle for UX/SOC 2 balance).
- Max length: ≥64 chars (don't truncate; argon2id has no 72-byte issue like bcrypt).
- No composition rules (no "must contain digit").
- No forced periodic rotation. Force rotation only on suspected compromise.
- **Breach check:** HIBP `/range/<sha1[:5]>` k-anonymity. No rate limit. On signup + password change. Block top-N (configurable, default 100) breach occurrences as well as exact match.
- **Lockout:** 5 failed attempts on a single account → 15 min lockout, with **exponential backoff up to 24 h** for repeated violations within a 24 h rolling window. Counter is per-`(tenant_id, username)`, not per-IP (prevents distributed brute force from circumventing). NIST cap is 100 consecutive failures; we're stricter.
- Password reset via emailed signed token (10-min TTL, single-use, JWT with `purpose=reset`).

---

## 4. SIP credential encryption design

### 4.1 What we're protecting

The DESIGN schema has two encrypted-at-rest fields:
1. `users.sip_password` — per-agent SIP password used for SIP.js WSS REGISTER.
2. `carriers.password` — per-carrier SIP gateway password used by FS Sofia gateway.

Plus future-proofing for: STIR/SHAKEN private keys, third-party API keys (HIBP, AWS, Twilio API), webhook signing secrets.

### 4.2 Envelope encryption pattern

```
KEK (Key Encryption Key)            ─── lives in env / Vault Transit / KMS
   │ wraps
   ▼
DEK (per-row Data Encryption Key)   ─── 256-bit random; encrypted with KEK,
   │ encrypts                          stored alongside ciphertext as `dek_wrapped`
   ▼
plaintext credential
```

Per-row DEK enables targeted re-encryption (e.g., on user delete: zeroize DEK alone) and KEK rotation without payload re-encryption (just re-wrap DEKs).

### 4.3 AES-GCM-256 specifics

- Key: 256-bit (recommended over 128-bit per OWASP Crypto Storage cheat sheet).
- IV/nonce: **96-bit, random per encrypt, never reused**. Crypto library (Node `crypto.createCipheriv` or `@noble/ciphers`) handles this.
- Tag: 128-bit, appended to ciphertext.
- **AAD (Additional Authenticated Data):** binds the ciphertext to its row identity. Compute as:
  ```
  AAD = SHA-256("<table>:<column>:<row_id>:<tenant_id>:<key_id>")
  ```
  Prevents an attacker with DB write access from copying ciphertext from row A into row B (would fail GCM auth).

Storage layout (single MySQL column, BLOB or JSON):

```json
{
  "v": 1,
  "kid": "kek-2026-1",
  "alg": "AES-256-GCM",
  "dek_wrap": "<base64 of KEK(DEK)>",
  "iv": "<base64 96-bit>",
  "ct": "<base64 ciphertext>",
  "tag": "<base64 128-bit>",
  "aad_hash": "<sha256 hex>"
}
```

We could split across columns; single-column JSON is simpler for ORM round-trips.

### 4.4 KEK location decisions

| Phase | KEK location | Rationale |
|---|---|---|
| **Phase 1 (MVP)** | env var `VICI2_KEK_BASE64` (32 bytes) | Simplest. Documented constraint for self-hosters. |
| Phase 4 (multi-tenant SaaS) | **HashiCorp Vault Transit** (preferred) or **AWS KMS** customer-managed key | Full audit trail, no plaintext KEK in app memory, supports automated rotation. |

Vault Transit is preferred over AWS KMS for self-hostability (Vici2 must run on-prem too). KMS-only deployments use the standard `GenerateDataKey`/`Decrypt` round-trip; Vault uses `transit/encrypt/<key>` and `transit/decrypt/<key>`. Both follow the same envelope pattern.

**Open question for orchestrator:** is Phase-4 KMS in scope at all, or do we permanently target env+Vault? Flagging as scope decision.

### 4.5 Key rotation

- **DEK rotation:** automatic when ciphertext length > 32 GB (NIST SP 800-38D limit on a single key); n/a for password-sized payloads but document.
- **KEK rotation procedure** (manual, Phase 1; tooling Phase 4):
  1. Generate `kek-N+1`, add to env / Vault keyring.
  2. Background job iterates rows, decrypts DEK with `kek-N`, re-wraps with `kek-N+1`, writes back. **Payload ciphertext untouched.**
  3. Once all rows show `kid=kek-N+1`, retire `kek-N` from env. Keep historical KEK in Vault for backup decryption.
- **On compromise:** rotate KEK + force agent password reset + rotate all SIP passwords (FS reload). Document as runbook entry under `spec/runbooks/auth-key-compromise.md` (deliverable in IMPL).

### 4.6 SIP credential serving to FreeSWITCH

Two paths considered:

**Path A — static XML on disk (Phase 1 spec)**
- Pros: simple, no API dependency for FS startup, no runtime call cost.
- Cons: cleartext password sits on disk in `freeswitch/conf/directory/default/<id>.xml`. Mitigation: file mode 0640 owned by `freeswitch:freeswitch`, encrypted root volume, never committed to git. Re-render on `users.sip_password` change + ESL `reloadxml`.

**Path B — mod_xml_curl runtime binding (Phase 2+)**
- Pros: SIP password never on disk. Decrypted only in-memory at API at request time. Full audit trail of FS-→API directory lookups.
- Cons: API becomes a dependency for SIP REGISTER. Latency cost. Cache must be tuned (FS caches XML responses; `cacheable` attr). Requires loopback-only HTTP binding with IP-allowlist.

**Recommendation:** Phase 1 = Path A as currently spec'd. **PLAN should include a Phase-2 ticket to migrate to Path B** (mod_xml_curl on `http://127.0.0.1:3001/fs/directory`, basic auth via shared secret in env, with FS `xml_curl.conf` `cacheable="60"` to limit hot-path load).

**Digest-auth alternative (future):** FS `a1-hash` param accepts `MD5(user:domain:password)` so we could store the a1-hash instead of the plaintext password. Downside: SIP digest is locked to MD5 — the a1-hash is effectively as compromising as the plaintext for that user. Only marginal gain. Skip for now.

---

## 5. RBAC model

### 5.1 Roles (hierarchical)

```
super_admin   — multi-tenant operator (Phase 4); has *.*
   ↓
admin         — within a tenant; everything except cross-tenant ops
   ↓
supervisor    — read across agents in their groups + listen/whisper/barge
   ↓
agent         — only their own state and assigned leads

integrator    — machine-to-machine (Phase 4 N01); orthogonal axis, scoped via API key
```

Hierarchy is consulted via a static priority list (`@yikesable/fastify-acl` pattern) so a route requiring `supervisor` automatically admits `admin` + `super_admin`.

### 5.2 Permission verbs (action:resource)

Initial set (extensible):

| Verb | Description |
|---|---|
| `auth:login`, `auth:logout` | self |
| `user:create`, `user:edit`, `user:delete` | admin+ |
| `user:rotate-sip` | admin+ self-allowed for own row |
| `lead:read`, `lead:edit`, `lead:create`, `lead:delete` | agent: own assigned; admin: all |
| `call:dial`, `call:hangup`, `call:transfer`, `call:hold` | agent self-context |
| `call:eavesdrop`, `call:whisper`, `call:barge` | supervisor+ |
| `recording:list`, `recording:play`, `recording:download` | supervisor+; admin: all |
| `campaign:read`, `campaign:edit`, `campaign:create` | admin+ |
| `carrier:read`, `carrier:edit` | admin+ |
| `dnc:read`, `dnc:add`, `dnc:bypass` | admin+; `dnc:bypass` requires `super_admin` |
| `audit:view` | super_admin (compliance read-only) |
| `kek:rotate` | super_admin |

### 5.3 Resource scoping (tenant boundary)

**Hard rule (DESIGN.md §4.5):** every persisted row has `tenant_id`. Every JWT carries `tid`. Every middleware compares `resource.tenant_id == jwt.tid`. **No handler is permitted to bypass this** — a CI check greps for raw Prisma queries that don't include `tenant_id` in `where`.

For Redis: every key prefixed `t:{tid}:`. Permission middleware also asserts the `WS` channel name matches `t:{jwt.tid}:`.

### 5.4 Self-only routes

Pattern: `requireOwn(extractor)`, where `extractor(req)` returns the resource's `user_id`. Middleware compares to `jwt.uid`. Used for `POST /api/auth/sip/rotate`, `GET /api/agent/me`, etc. Admins can override (`requireOwn` short-circuits if role >= admin).

### 5.5 Middleware composition (Fastify)

```
preValidation (pseudo-flow):
  1. extract Bearer token from Authorization header (or cookie for browser path)
  2. verify JWT signature + iss/aud/exp via @fastify/jwt
  3. attach req.auth = { uid, tid, role, perms }
  4. requireRole(role) — hierarchy check
  5. requirePermission(verb) — flat-set check
  6. requireTenant() — applied via fastify hook to every route except /auth/login
  7. requireOwn(extractor) — only on self-scoped routes
```

Composing via `@fastify/auth` lets us combine "admin OR own" into one preValidation chain.

### 5.6 Force-logout on permission change

When admin demotes/disables a user: revoke all that user's refresh tokens (Redis `DEL t:{tid}:auth:refresh:user:{uid}:*`) and add their `uid` to a "stale-since" set checked on every JWT verify. Access tokens are still valid for ≤15 min; the WS gateway re-checks on next message and disconnects if stale. Acceptable Phase-1 behavior (no continuous-revocation; SOC 2 controls accept ≤15 min).

---

## 6. WebSocket auth

### 6.1 Initial handshake

**Preferred:** subprotocol header.
```
Sec-WebSocket-Protocol: vici2.jwt.eyJhbGciOi...
```
Server's `handleProtocols` extracts and verifies before upgrade. If invalid → `401`, no socket established.

**Acceptable:** query string `?token=...` over WSS. Easier for some browsers but **logged in proxy access logs**. Mitigations: short-lived access tokens (15 min); no PII in URL (token alone is rotatable).

**Cookie path:** if browser uses httpOnly refresh cookie + access in JS memory, the WS handshake naturally carries the cookie; we extract refresh, verify, mint a short ws-only access token. More moving parts. Defer.

### 6.2 Re-auth without disconnect

Pattern from `hstm/fastify-uws-auth` (production reference):

1. Server tracks `expires_at` per socket on connect.
2. 2 minutes before expiry, server sends `{type:'token_expiring', expires_at}`.
3. Client requests new access via REST `/auth/refresh` (refresh-token-rotation).
4. Client sends `{type:'reauth', access:'<new>'}` over WS.
5. Server verifies, updates `expires_at`. Connection persists.

Saves the audio-conference-occupancy churn that would otherwise happen on agent SIP.js disconnect.

### 6.3 Per-message authorization

For non-trivial actions over WS (e.g., `agent.transfer`), re-check `req.auth.perms` on each message — JWT was verified at handshake, but the role/perms attached to socket state must include the verb. No new token verify per message (cost), just attached-state check.

### 6.4 SIP.js WSS leg

**Independent path.** Browser opens `wss://fs.example.com:7443` to FreeSWITCH directly. Auth = SIP digest with `sip_password`. JWT is **not** in this path. Compromise of SIP password ≠ compromise of API access; distinct credentials, distinct rotation.

---

## 7. 2FA scope (now vs Phase 2)

### 7.1 MVP (Phase 1) — no 2FA in core flow

Rationale: agent UX is high-volume; 2FA-on-every-login disrupts shift starts. Initial MVP relies on:
- Strong argon2id hashing
- Breach-checked passwords (HIBP)
- Account lockout
- Short-lived access tokens
- Audit logging of all logins

### 7.2 Phase 2 — TOTP for admin/supervisor

- RFC 6238 TOTP, 30-s step, SHA-1 (default for compatibility with Google Authenticator, Authy, 1Password).
- Secret = 160-bit random, stored encrypted (envelope as in §4) in `user_totp_secrets` table.
- Enrollment via QR code (`otpauth://totp/...`).
- 10 backup codes, single-use, hashed (argon2id) at rest.
- ±1 step drift window.
- **Mandatory for `admin` and `super_admin` roles.** Optional for `supervisor`. Off by default for `agent` (UX).

### 7.3 Phase 3 / 4 — WebAuthn (FIDO2)

- Use `@simplewebauthn/server` (Node) — vetted, RFC-aligned.
- Replaces TOTP for super_admin once available; both can coexist.
- Resident credentials enable passwordless flow (Phase 4+).
- Higher dev cost than TOTP (~1 week vs ~2 days), but compromise-resistant in ways TOTP isn't (phishing-proof).

### 7.4 Decision flagged for orchestrator

Spec doesn't currently include 2FA in F05 acceptance criteria. **Recommendation:** keep Phase-1 F05 free of 2FA, add a new module `F06 — 2FA (TOTP)` for Phase 2 — clean split, no scope creep on F05's already-large surface.

---

## 8. Audit-log integration

### 8.1 What gets logged

| Event | Severity | Details captured |
|---|---|---|
| `auth.login.ok` | info | user_id, ip, ua |
| `auth.login.fail` | warn | username (no pw), ip, ua, reason |
| `auth.logout` | info | user_id, ip |
| `auth.refresh.ok` | info | user_id, family_id |
| `auth.refresh.reuse_detected` | **alert** | user_id, family_id, ip — triggers PagerDuty/email |
| `auth.lockout` | warn | user_id, attempts, duration |
| `auth.password.change` | info | user_id, by_user_id |
| `auth.password.reset_requested` | info | user_id, ip |
| `auth.totp.enabled` / `.disabled` | info (Phase 2) | user_id |
| `auth.sip.rotate` | info | user_id, by_user_id |
| `auth.role.change` | warn | user_id, from_role, to_role, by_user_id |
| `auth.user.create` / `.delete` | warn | user_id, by_user_id |
| `auth.kek.rotate` | warn | by_user_id, from_kid, to_kid |

### 8.2 Format (matches C03 audit log spec)

```sql
INSERT INTO audit_events (
  ts, tenant_id, actor_user_id, action, resource_type, resource_id,
  ip, user_agent, outcome, details_json
) VALUES (...);
```

Written **inside the same Prisma transaction** as the action being audited (DESIGN.md §4.7). Async-flush-to-S3 is C04's job, not ours.

### 8.3 No-secrets rule

Hard CI grep for the strings `sip_password`, `passwordHash`, `dek_wrap`, `Bearer ey`, `JWT_SIGNING_KEY` in committed code paths that touch the logger. Fail the PR build on hit. F05 acceptance criteria already includes "No secrets logged (verified by grep CI step)" — implementer to wire that step in `O04`.

---

## 9. Compliance notes (SOC 2, GDPR)

### 9.1 SOC 2 Type II — relevant controls F05 implements

| Criterion | Control | F05 evidence |
|---|---|---|
| CC6.1 | Logical access; password policy | argon2id config, NIST-aligned policy, lockout table |
| CC6.2 | Authentication of users | JWT verify, MFA roadmap, refresh-token rotation |
| CC6.3 | Removal of access | Force-logout on demotion, token-family revoke |
| CC6.6 | Encryption in transit | WSS for SIP.js, TLS for API (handled by F01/O05) |
| CC6.7 | Encryption at rest | AES-GCM-256 envelope on SIP/carrier creds |
| CC6.8 | Key management | KEK rotation procedure, JWKS rotation |
| CC7.2 | Monitoring of auth events | Audit log on every login, alert on refresh-reuse |
| CC7.3 | Incident detection | refresh-reuse-detected → alert |

Evidence types auditors will sample: argon2id params printout, JWT issuance logs, refresh-rotation logs, KEK-rotation receipts, lockout occurrences with timestamps, audit-log immutability (C03's responsibility but F05 generates rows).

### 9.2 GDPR — right to erasure

When a user invokes Article 17:

- **Delete:** `users` row's PII fields (full_name, email), `sip_password` ciphertext + DEK, all stored TOTP secrets, refresh tokens (Redis `DEL t:{tid}:auth:refresh:user:{uid}:*`), session data.
- **Pseudonymize, do not delete:** `audit_events` rows referring to that user (legal hold + 4-year TCPA retention requires this). Replace `actor_user_id` with a stable opaque token; the `users.id` row is kept as a tombstone with `deleted_at` set and PII columns nulled. Pattern matches AppMaster / Channel.tel "pseudonymization layer" guidance: audit trails survive with meaningless identifiers.
- **30-day deadline.** Document the retention exception ("4-year TCPA litigation-defense statute") in deletion-receipt response.

### 9.3 Telephony-specific notes

- SIP passwords are credentials, not PII — but a SIP password is **bound to a `user_id` which IS PII**, so on user-erasure we still rotate/nuke the SIP password.
- Carrier credentials are **the operator's** secrets, not the customer's. GDPR doesn't apply but SOC 2 confidentiality does.
- Audit `audit:view` access itself: viewing audit logs creates an audit row (per AppMaster). Recursive but bounded.

---

## 10. Open questions for PLAN

1. **EdDSA support across the stack:** confirm `fast-jwt` (under @fastify/jwt) verify path supports EdDSA in our pinned version — or do we ship with RS256 and migrate later? (PLAN: explicit version pin.)
2. **Pepper:** add HMAC pepper from day 1 (yes/no)? Trade-off: stronger defense, harder rotation. Default recommendation: yes.
3. **HIBP integration:** online API (free, no rate limit, k-anonymity safe) vs offline pwned-passwords download (~37 GB, weekly refresh)? PLAN: online for Phase 1, offline-mode flag for air-gapped deployments.
4. **mod_xml_curl runtime path:** ship in Phase 1 (against current F05.md spec) or hold to Phase 2? Trade-off: simpler MVP vs cleartext-on-disk hardening item open. Recommendation: hold to Phase 2; document risk in HANDOFF.
5. **KMS scope:** is HashiCorp Vault Transit a realistic Phase-4 target, or do we bake AWS KMS in directly? Affects on-prem deployments. **Flag for orchestrator.**
6. **2FA module:** carve into separate F06 module (Phase 2) or stay nested in F05? Recommendation: separate F06.
7. **`integrator` role in Phase 1:** does any Phase-1 module actually need it? (N01 is Phase 4.) If no, defer the role definition.
8. **CSRF for cookie-based refresh:** if we go cookie path for browser refresh tokens, double-submit token is required. Header-only path avoids CSRF entirely. PLAN: pick one path and freeze.
9. **Refresh-token grace window:** 0 sec or 30 sec? Affects mobile clients but introduces a small reuse-detection window. Default recommendation: 0 sec.
10. **Audit retention tiering:** auth events go to MySQL `audit_events` and async-archive to S3 (C04). Are auth events sensitive enough to require S3 Object Lock from day one, or is C04's general retention schedule fine? Recommendation: yes, Object Lock from day 1 — TCPA defensibility.

---

## 11. Citations

1. **OWASP — Password Storage Cheat Sheet (2026)** — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html — argon2id parameter recommendations m=46MiB/19MiB/12MiB, peppering guidance, KDF priority.
2. **OWASP — JSON Web Token Cheat Sheet** — https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html — algorithm pinning, key length, sessionStorage vs cookie trade-offs.
3. **OWASP — Authentication Cheat Sheet** — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html — lockout thresholds, exponential backoff, credential stuffing.
4. **OWASP — Cryptographic Storage Cheat Sheet** — https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html — KEK/DEK envelope, AES-GCM, key rotation.
5. **OWASP — OAuth 2.0 Cheat Sheet** — https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html — refresh-token sender-constraining or rotation.
6. **OWASP Top 10 — A07:2025 Authentication Failures** — https://owasp.org/Top10/2025/A07_2025-Authentication_Failures/ — NIST 800-63B alignment, MFA, no forced rotation.
7. **OWASP ASVS Issue #2110 — Refresh-token rotation requirements (L1/L2)** — https://github.com/OWASP/ASVS/issues/2110 — reuse-triggered family revocation as ASVS L1 requirement.
8. **NIST SP 800-63B Rev 4 — Memorized Secrets** — https://pages.nist.gov/800-63-3/sp800-63b.html — minimum length, no composition rules, breach checks, rate limiting.
9. **RFC 9106 — Argon2 Memory-Hard Function** — https://rfc-editor.org/rfc/rfc9106.html — parameter recommendation procedure, FIRST/SECOND RECOMMENDED.
10. **RFC 6238 — TOTP** — https://datatracker.ietf.org/doc/html/rfc6238 — 30-s time step, key length, drift.
11. **RFC 8032 — EdDSA (Ed25519)** — https://datatracker.ietf.org/doc/html/rfc8032 — 32 B key, 64 B signature, deterministic, side-channel resistance.
12. **RFC 8037 — EdDSA in JOSE/JWT** — https://datatracker.ietf.org/doc/html/rfc8037 — `EdDSA` alg name, OKP key type, Ed25519 / Ed448 curves.
13. **RFC 9700 — OAuth 2.0 Security Best Current Practice** (Jan 2025) — https://ftp.ripe.net/rfc/rfc9700.pdf — sender-constraining, refresh-token rotation, replay prevention.
14. **Auth0 — Refresh Token Rotation** — https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation — RTR pattern, automatic reuse detection, family revocation, `ferrt` log event.
15. **Okta — Refresh Tokens & Rotation** — https://developer.okta.com/docs/guides/refresh-tokens/main/ — reuse detection, 30-s grace window option.
16. **Have I Been Pwned — Pwned Passwords API v3** — https://haveibeenpwned.com/API/v3 — k-anonymity range query, no rate limit, offline downloader.
17. **AWS KMS — Concepts** — https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html — customer-managed key, GenerateDataKey, encryption context (AAD).
18. **HashiCorp Vault — Transit Secrets Engine** — https://developer.hashicorp.com/vault/docs/secrets/transit — encrypt/decrypt on KEK without exposing it.
19. **FreeSWITCH — XML User Directory** — https://freeswitch.org/confluence/display/FREESWITCH/XML+User+Directory — directory user XML, `password` vs `a1-hash` param.
20. **FreeSWITCH — mod_xml_curl** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_xml_curl_1049001/ — runtime directory binding, GET/POST, gateway-credentials, cacheable hint.
21. **WebAuthn Guide** — https://webauthn.guide/ — registration/authentication ceremonies, challenge handling, attestation modes.
22. **node-argon2 (ranisalt) — Options Wiki** — https://github.com/ranisalt/node-argon2/wiki/Options — defaults, calibration, type=argon2id.
23. **`@fastify/jwt`** — https://github.com/fastify/fastify-jwt — fast-jwt under the hood, cookie & header support, trusted-token blacklist hook.
24. **`@fastify/websocket`** — https://github.com/fastify/fastify-websocket — preValidation hook for WS auth, lifecycle interaction.
25. **hstm/fastify-uws-auth** — https://github.com/hstm/fastify-uws-auth — production reference for Fastify+WS+RTR with token-family tracking.
26. **AppMaster — Privacy deletion vs audit needs** — https://appmaster.io/blog/privacy-deletion-audit-compromise-patterns — pseudonymization vs anonymization, tombstone records.
27. **Channel.tel — GDPR vs EU AI Act memory compliance** — https://www.channel.tel/blog/gdpr-delete-eu-ai-act-keep-memory-compliance — pseudonymization-layer architecture for audit-vs-erasure.
28. **SOC 2 Type II Cloud Hosting Requirements 2025 (Ciro Cloud)** — https://cirocloud.com/artikel/soc2-type-ii-cloud-hosting-requirements-checklist-2025-complete-guide — encryption-at-rest, key rotation, log immutability.
29. **NIST SP 800-63B Rev 4 password requirements interpretation (SecureLeap)** — https://www.secureleap.tech/blog/soc-2-password-requirements — 15-char single-factor, 8-char with MFA, breach-screening.
30. **RFC 9106 §7.4 default recommendations** — https://rfc-editor.org/rfc/rfc9106.html#name-recommendations — FIRST RECOMMENDED (m=2GiB, t=1, p=4), SECOND RECOMMENDED (m=64MiB, t=3, p=4).

---

**End of RESEARCH.md.** Ready for orchestrator review. PLAN phase blocked on F02 (users/tenants schema) — once F02 HANDOFF lands, F05 PLAN can proceed in ~1 day.
