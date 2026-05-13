# F05 — Auth + RBAC + SIP Credential Storage — PLAN

**Module:** F05 (Foundation, Phase 1)
**Author:** F05 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 30 citations behind every choice.
**Depends on (PLANs already FROZEN):** F01, F02, F03, F04.
**Blocks:** A01, A02, M01, T02, C03, every protected API route.

This plan turns the F05 spec + RESEARCH findings into the concrete cryptographic
choices, code structure, integration points, and test strategy the IMPLEMENT
phase will deliver. Once approved, the public surface (token shape, claim
names, env var names, encryption blob layout, RBAC verbs, audit event names)
is FROZEN. Internal implementation (helper layout, Lua source phrasing,
Fastify hook composition order) may change without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **JWT = EdDSA (Ed25519)** primary; **RS256** documented escape-hatch for
   any consumer that can't speak OKP. **HS256 rejected** (Go dialer needs to
   verify what Node API signed — asymmetric is the cleaner trust boundary).
   `kid` header is mandatory; JWKS exposed at
   `GET /auth/.well-known/jwks.json` (public keys only, 5-min `Cache-Control`).
2. **Token lifetimes:** access **15 min** (all audiences), refresh **30 d
   agent / 7 d admin+supervisor**, integrator M2M **60 min, no refresh**
   (re-auth via `client_credentials`). Browser-side opaque refresh token
   stored in Valkey (F04) — never a JWT, never decryptable from memory dump.
3. **Refresh-token reuse → revoke entire family.** Lua-atomic `GETDEL`
   (`refresh_consume.v1.lua`) loaded once via `SCRIPT LOAD`; on miss after
   pop, the script `KEYS *` the family prefix and DELs. Fires
   `auth.refresh.reuse_detected` audit event at severity **page**.
4. **Argon2id parameters (OWASP 2026 floor):** `m=19456 KiB, t=2, p=1`,
   plus install-time calibration that bumps `m` until a single hash takes
   ~500 ms on the target host. Re-hash on login if stored params < current.
   **HMAC pepper from day 1** via env `VICI2_PASSWORD_PEPPER` (32 bytes).
5. **Password policy:** **12-char min**, no composition rules, no forced
   rotation, **HIBP k-anonymity check** on signup + change with 24-h
   negative cache. **5-fail / 15-min lockout** per `(tenant_id, username)`
   with exponential back-off `15m → 30m → 60m → 2h → 4h cap`.
6. **AES-GCM-256 envelope encryption** for at-rest secrets (SIP passwords,
   carrier passwords, future TOTP / API keys). Per-row 256-bit DEK wrapped
   by per-version KEK (`VICI2_KEK_V1` env in Phase 1; **HashiCorp Vault
   Transit** primary + **AWS KMS** secondary in Phase 4). 96-bit random IV
   per encrypt; **AAD = SHA-256(`table:column:row_id:tenant_id:kek_version`)**
   — binds ciphertext to its row, prevents swap attacks. Stored as
   `VARBINARY(512)` per F02 PLAN's `sip_credentials.sip_password_ct` column.
7. **SIP credential serving (Phase 1) = static XML directory** rendered to
   `/etc/freeswitch/directory/<domain>/<user_id>.xml` at agent-create /
   sip-rotate / agent-update time. F03's `mod_xml_curl` `<bindings/>` stay
   **EMPTY in Phase 1** (per F03 PLAN §10). **Phase 2 ticket** filed:
   migrate to xml_curl runtime binding on loopback so cleartext never
   touches disk. Phase-1 file mode: `0640 root:freeswitch`, encrypted
   root volume, single-flight write queue.
8. **RBAC = static in-code matrix.** Hierarchical
   `super_admin > admin > supervisor > agent` plus orthogonal `integrator`
   (M2M, no UI). Permissions are `verb:resource` strings; matrix lives in
   `shared/types/src/rbac.ts` as the single source of truth and is
   re-exported into `api/src/auth/rbac.ts` (TS) and code-generated into
   `dialer/internal/auth/rbac.go` (Go) by a `make gen-rbac` build step.
9. **Tenant boundary always enforced.** Every persisted row carries
   `tenant_id` (F02 contract). Every JWT carries `tenant_id`. Every route
   passes through `requireTenant` middleware that compares JWT claim to
   path/body/query. **CI grep test fails** on any handler that doesn't go
   through `requireAuth`. **No raw role checks in handlers** — only
   middleware decorators.
10. **2FA carved into F06 (Phase 2 — TOTP, Phase 3 — WebAuthn).** F05 ships
    schema hooks (`users.totp_required` BOOLEAN, session has
    `totp_verified` flag, `requireTotp` middleware stub) so F06 plugs in
    without re-migration. **KMS deferred to Phase 4** (env-only KEK in
    Phase 1; rewrap-in-batch migration documented).

---

## 1. JWT design (FINAL)

### 1.1 Algorithm

| Algorithm | Status | Reason |
|---|---|---|
| **EdDSA (Ed25519)** | **Primary** | Deterministic, side-channel safe, 32 B key, 64 B sig (RFC 8032/8037). `jose` v5 (Node) and `golang-jwt/jwt/v5` (Go) both verify it. |
| **RS256** | Documented fallback | If a downstream consumer (legacy SDK, hardware token) refuses OKP. Switch by env flag `VICI2_JWT_ALG=RS256` and corresponding key envs. |
| HS256, ES256 | Rejected | HS256 forces shared-secret across services; ES256 has RNG-on-sign foot-gun. |

Library choice: **`jose`** (latest 5.x) — ESM, supports EdDSA verify in pure
JS, JWK & JWKS helpers, well-audited. **NOT `@fastify/jwt`** (which wraps
`fast-jwt`); we use `jose` directly inside our `jwt.ts` helper so we control
key rotation, kid lookup, and JWKS serving uniformly.

### 1.2 Keys & rotation

- **Generation:** one-shot `scripts/gen-jwt-keys.sh`. Outputs JWK(S) pair
  with `kid = ed25519-{YYYY}-{N}` (e.g. `ed25519-2026-1`). Private JWK
  goes to env `VICI2_JWT_PRIVATE_KEY_JWK` (base64-encoded JSON), public
  JWK to `VICI2_JWT_PUBLIC_KEY_JWK`. Multi-key support via
  `VICI2_JWT_PRIVATE_KEY_JWK` (current signer) + `VICI2_JWT_PUBLIC_KEYS_JWKS`
  (JWKS-shaped array of accepted verifiers, including the historic key
  during overlap).
- **Rotation procedure:**
  1. Generate `kid = ed25519-2026-2`. Append to `VICI2_JWT_PUBLIC_KEYS_JWKS`.
     Restart api (rolling). All instances now **verify** old + new.
  2. After ≥ 1 deploy cycle (so all replicas accept new), set
     `VICI2_JWT_PRIVATE_KEY_JWK` to the new key. New tokens signed with
     `kid=...-2`. Old tokens still verify (we still publish old public).
  3. After max(refresh-TTL, 30 d), drop the old public from
     `VICI2_JWT_PUBLIC_KEYS_JWKS`. Restart. Old tokens all expired.
- **JWKS endpoint** (`GET /auth/.well-known/jwks.json`): returns the
  **public-key set** (current + grace). `Cache-Control: max-age=300,
  public`. CORS open (it's a public discovery doc). Go dialer caches
  JWKS for **60 s** (RESEARCH §2.2 says 1 week — we tighten because key
  rotation must propagate fast on compromise).
- **Admin-only** `POST /auth/keys/rotate` endpoint (Phase 2; Phase 1 ships
  the script + env-edit procedure as a runbook).

### 1.3 Token shape

**Access token (JWT, 15 min):**
```jsonc
{
  "iss": "vici2-api",
  "aud": "api",                     // or "ws" for WebSocket-scoped tokens
  "sub": "u_42",                    // string form of users.id
  "uid": 42,
  "tenant_id": 1,
  "role": "agent",                  // single role; hierarchy resolved at check time
  "perms": ["lead:read","call:dial",...],   // optional inline perms (≤ 4 KB header budget)
  "iat": 1746500000,
  "exp": 1746500900,
  "jti": "uuid-v7",
  "kid": "ed25519-2026-1",
  "totp_verified": true             // false if user has totp_required and hasn't entered it this session (Phase 2)
}
```

`aud` is **single-valued string** (RFC 7519 allows array OR string; we pick
string for unambiguous comparison). Two issued shapes:
- `aud: "api"` for REST/HTTP routes.
- `aud: "ws"` for the A03 WebSocket gateway. Issued via
  `POST /auth/ws-token` from a valid `aud:api` token; lifetime 15 min;
  `requireWsToken` middleware in A03 only accepts `aud: "ws"`.

**Refresh token (opaque, 30 d agent / 7 d admin):** 32 random bytes,
base64url-encoded (43-char string), **never a JWT**. Stored in Valkey;
**only SHA-256(token) is stored**, never the cleartext.

**Integrator (M2M) token:** access JWT only (60 min). `aud: "api"`,
`sub: "i_<id>"`, `role: "integrator"`, `perms: [...]` from the integrator
record. Re-auth via `POST /auth/oauth/token` with
`grant_type=client_credentials`, client_id + client_secret (Phase 4 N01).
Phase 1 ships the verifier path; issuance is stubbed (404).

### 1.4 Claims validation

Every verify step asserts:
- Signature OK against the JWK identified by `kid`.
- `iss == "vici2-api"`.
- `aud == "api"` (REST) or `aud == "ws"` (WS gateway).
- `exp > now` and `iat <= now + 60 s` (clock skew).
- `tenant_id` is an integer; `role` is in the static enum.
- `jti` not in revocation set (`revoked_jti:{jti}` Valkey keys with TTL =
  remaining exp — populated only on explicit `/auth/logout/all` or admin
  force-logout; not consulted on every verify, only spot-checked via short
  TTL cache).

---

## 2. Refresh-token storage (Valkey-backed family rotation)

### 2.1 Key namespace (uses F04 helpers)

All keys live in **DB 0** (state, no eviction). Tenant prefix per F04
convention. **No `{...}` cluster hash tag** — refresh keys spread across
shards in Phase 4.

| Key | Type | TTL | Notes |
|---|---|---|---|
| `t:{tid}:auth:refresh:{family_id}:{token_hash}` | HASH | `expires_at - now` | Per-token record. `token_hash = SHA-256(token_bytes)` hex. |
| `t:{tid}:auth:refresh:family:{family_id}` | SET | longest member TTL | Members = all `token_hash` values in the family; used by reuse-revoke. |
| `t:{tid}:auth:refresh:user:{user_id}` | SET | none (cleaned by janitor) | Members = all `family_id` for this user; used by force-logout. |
| `t:{tid}:auth:revoked_jti:{jti}` | STRING `"1"` | `exp - now` | Set on explicit logout-all only. |

Per-token HASH fields:
```
user_id, tenant_id, family_id, parent_token_hash (or "" for first), issued_at,
expires_at, last_ip, last_ua, role
```

### 2.2 Lua script: `refresh_consume.v1.lua`

Stored under `shared/lua/refresh_consume.v1.lua`. Loaded once via
`SCRIPT LOAD` at api boot (uses F04's bootstrap pattern). Called via
`EVALSHA` with `NOSCRIPT` auto-reload.

```lua
-- Atomically consume a refresh token. If the token exists, delete it,
-- return the token record's user_id|tenant_id|family_id|role|parent_hash.
-- If the token is missing AND the family still exists, this is a REUSE
-- attack: revoke the entire family and return REUSE_DETECTED|family_id.
--
-- KEYS[1] = t:{tid}:auth:refresh:{family_id}:{token_hash}
-- KEYS[2] = t:{tid}:auth:refresh:family:{family_id}
-- KEYS[3] = t:{tid}:auth:refresh:user:{user_id}    -- optional (caller may pass "" if unknown)
-- ARGV[1] = family_id (string, used in the REUSE return)
--
-- Returns:
--   {"OK", user_id, tenant_id, family_id, role, parent_hash, expires_at}
--   {"REUSE_DETECTED", family_id, n_keys_revoked}
--   {"NOT_FOUND"}

local rec = redis.call('HGETALL', KEYS[1])
if #rec > 0 then
  -- Build a kv table from HGETALL flat list
  local h = {}
  for i = 1, #rec, 2 do h[rec[i]] = rec[i+1] end
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], string.sub(KEYS[1], string.len(KEYS[1]) - 63))
  return {'OK', h.user_id, h.tenant_id, h.family_id, h.role,
          h.parent_token_hash, h.expires_at}
end

-- Miss. Is the family still around?
local family_size = redis.call('SCARD', KEYS[2])
if family_size > 0 then
  -- Nuke every token in the family
  local members = redis.call('SMEMBERS', KEYS[2])
  for i = 1, #members do
    -- Reconstruct each per-token key by replacing the trailing token_hash
    -- portion of KEYS[1] with the member. KEYS[1] format is fixed:
    -- t:{tid}:auth:refresh:{family_id}:<token_hash>
    local prefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - 64)
    redis.call('DEL', prefix .. members[i])
  end
  redis.call('DEL', KEYS[2])
  if KEYS[3] ~= '' then
    redis.call('SREM', KEYS[3], ARGV[1])
  end
  return {'REUSE_DETECTED', ARGV[1], tostring(family_size)}
end

return {'NOT_FOUND'}
```

**Notes:**
- The script length (~30 lines) keeps it safely under `lua-time-limit
  5000` ms.
- `token_hash` is **64 hex chars** (SHA-256). The `string.sub` math is
  fixed-width — if hashing changes, the script must be reissued as `.v2`.
- Per F04 convention: any change is a new file (`.v2.lua`); helper lib
  re-loads on boot and on `NOSCRIPT`.

### 2.3 Issuance flow

```
login OK / refresh OK
  → token = randomBytes(32)
  → token_hash = sha256(token)
  → family_id = (existing family on refresh) or uuidv7() (on login)
  → parent = previous token_hash (or "")
  → HSET t:{tid}:auth:refresh:{family_id}:{token_hash} user_id ... expires_at ...
  → EXPIRE that key (expires_at - now)
  → SADD t:{tid}:auth:refresh:family:{family_id} {token_hash}
  → EXPIRE that family set to longest current member TTL
  → SADD t:{tid}:auth:refresh:user:{user_id} {family_id}
  → return base64url(token) + family_id to caller
```

### 2.4 Audit on reuse

`auth.refresh.reuse_detected` audit row severity **page** — handled by
O01 alerting; PagerDuty + email per the runbook (deliverable in F05
HANDOFF).

---

## 3. Argon2id parameters (FINAL)

### 3.1 Library & defaults

- **Node:** `@node-rs/argon2` (Rust-binding, ~6× faster than `node-argon2`,
  CommonJS+ESM, no native compile pain on Alpine). Pinned `^2.0.0`.
- **PHC string** is the storage format; embeds `m,t,p,salt,hash` so the
  algo upgrade path is "rehash on login if `params(stored) < params(current)`".

### 3.2 Phase-1 floor (OWASP 2026 SECOND-RECOMMENDED row)

| Param | Value | Source |
|---|---|---|
| memory_cost (`m`) | **19456 KiB** (19 MiB) | OWASP min row B |
| time_cost (`t`) | **2** | OWASP min row B |
| parallelism (`p`) | **1** | OWASP min row B (Node single-thread reality) |
| salt | 16 random bytes (default) | RFC 9106 |
| hash length | 32 bytes | default |

### 3.3 Install-time calibration

`scripts/calibrate-argon2.ts` (run once at install or on
`make calibrate`):
- Increase `m` in 8 MiB steps until a single hash takes 250–500 ms on
  the target box (OWASP guidance).
- Persist `(m, t, p)` to `auth_config` table:
  ```sql
  CREATE TABLE auth_config (
    id            TINYINT NOT NULL DEFAULT 1 PRIMARY KEY CHECK (id = 1),
    argon2_m      INT NOT NULL,
    argon2_t      INT NOT NULL,
    argon2_p      INT NOT NULL,
    updated_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  );
  ```
  (F02 amendment ticket — non-controversial; single-row config table.)
- New hashes use the persisted params. On login, if stored hash params <
  persisted, rehash silently and update.

### 3.4 HMAC pepper (day-1)

- Env `VICI2_PASSWORD_PEPPER` = base64-encoded **32 random bytes**.
- `verify(password, hash) = argon2_verify(HMAC-SHA-256(pepper, password), hash)`.
- Pepper rotation forces all-user re-hash on next login (we accept this;
  document in HANDOFF). No pepper-versioning column in Phase 1 (would
  add complexity without immediate need).

### 3.5 Password policy

| Rule | Value |
|---|---|
| Min length | **12 chars** |
| Max length | **256 chars** (no truncation; argon2id has no 72-byte issue) |
| Composition rules | **None** (NIST SP 800-63B Rev 4) |
| Forced rotation | **Never** (only on suspected compromise) |
| Breach check | **HIBP** k-anonymity range API on signup + change |
| HIBP cache | 24 h negative-result cache in Valkey DB 1 (`cache:hibp:{sha1_prefix}`) |
| HIBP fallback | Air-gapped flag `HIBP_OFFLINE=true` skips the check + warns; offline pwned-passwords download deferred to Phase 4 |
| Lockout | **5 fails in 15 min** per `(tenant_id, username)` |
| Lockout backoff | 15m → 30m → 60m → 2h → **4h cap** |
| Reset link | Signed JWT (`aud="reset"`, 10-min TTL, single-use via Valkey jti-set) |

Lockout state lives in Valkey: `t:{tid}:auth:lockout:{username}` HASH
with `fail_count, last_fail_at, locked_until`. Counter resets on
successful login.

---

## 4. AES-GCM-256 envelope encryption (CONCRETE)

### 4.1 KEKs

- **Phase 1:** env vars
  ```
  VICI2_KEK_V1 = base64(32 random bytes)
  VICI2_KEK_V2 = (set when rotating)
  VICI2_KEK_V3 = ...
  VICI2_KEK_CURRENT_VERSION = 1   # which version to USE for new encryptions
  ```
  Multiple versions accepted simultaneously for decryption; `CURRENT_VERSION`
  controls which is used to wrap new DEKs.
- **Phase 4:** **HashiCorp Vault Transit** primary, **AWS KMS** secondary
  (operator picks one at deploy time via `VICI2_KEK_PROVIDER=env|vault|kms`).
  Encryption ops become RPCs to Vault Transit (`transit/encrypt/<key>`,
  `transit/decrypt/<key>`); KEK material never leaves the Vault enclave.

### 4.2 DEK

- Per-row: 32 random bytes generated at encrypt time.
- Wrapped with current KEK using **AES-256-GCM** (KEK-AAD =
  `"vici2:kek-wrap:v" + version`). 96-bit random IV for the wrap, 128-bit
  tag.
- Wrapped DEK stored inside the same blob as the payload.

### 4.3 IV / nonce

- 96-bit random per encrypt (Node `crypto.randomBytes(12)`).
- Never reused; document in code comment.

### 4.4 AAD (Additional Authenticated Data)

```
AAD = SHA-256("table:" || table || ":column:" || column ||
              ":row_id:" || row_id || ":tenant_id:" || tenant_id ||
              ":kek_version:" || kek_version)
```
Binds ciphertext to its row identity. An attacker with DB write access
who copies a `sip_password_ct` from row A into row B will fail GCM auth
on decrypt.

### 4.5 Stored blob layout (FROZEN)

Stored in `VARBINARY(512)` (matches F02 PLAN's `sip_credentials.sip_password_ct`).
**Packed binary** (no JSON), little-endian where applicable:

```
offset  bytes  field                                description
------  -----  -----------------------------------  --------------------
0       1      version_byte                          0x01 = layout v1
1       2      kek_version (u16 LE)                  matches sip_credentials.kek_version SMALLINT
3       12     dek_wrap_iv                           96-bit random IV used to wrap the DEK
15      32     dek_wrap_ct                           AES-256-GCM(KEK_v, DEK)
47      16     dek_wrap_tag                          GCM auth tag for the DEK wrap
63      12     payload_iv                            96-bit random IV used to encrypt the payload
75      N      payload_ct                            AES-256-GCM(DEK, plaintext, AAD)
75+N    16     payload_tag                           GCM auth tag for the payload
```

For a SIP password ≤ 64 chars, total blob ≤ 91 + 64 = ~155 bytes; well
under VARBINARY(512) ceiling. The 512-byte cap is sized for future
storage of carrier API keys, STIR/SHAKEN private keys (separate column,
same layout).

`kek_version` is duplicated into the row's `kek_version SMALLINT` column
(per F02 PLAN) for **bulk re-encryption queries** (`SELECT id WHERE
kek_version < 2`). The in-blob copy is the cryptographic source of
truth; the column is a query optimization.

### 4.6 Helper API (api/src/auth/encryption.ts)

```ts
// shape only; no implementation in PLAN
export interface EncryptParams {
  table: string;     // "sip_credentials"
  column: string;    // "sip_password_ct"
  rowId: bigint;     // sip_credentials.id
  tenantId: bigint;  // sip_credentials.tenant_id
  plaintext: string | Uint8Array;
}

export interface DecryptParams {
  table: string;
  column: string;
  rowId: bigint;
  tenantId: bigint;
  ciphertextBlob: Uint8Array;
}

export function encrypt(p: EncryptParams): {
  ciphertextBlob: Uint8Array;
  kekVersion: number;
};

export function decrypt(p: DecryptParams): Uint8Array;

// Bulk re-wrap (KEK rotation tooling)
export async function rewrapAll(opts: {
  fromVersion: number;
  toVersion: number;
  batchSize: number;
  table: 'sip_credentials' | 'integrators' | 'totp_secrets';
}): Promise<{ rewrapped: number; failed: number }>;
```

**Decrypt-cache (latency mitigation):** `LRUCache` of decrypted DEKs keyed
by `rowId`, **30-second TTL**, max 1024 entries. Cleared on KEK rotation.
The plaintext SIP password itself is **never cached** — only the DEK,
which is bounded by KEK lifetime.

### 4.7 Rotation runbook (Phase 1, manual)

Documented in F05 HANDOFF. Summary:
1. Generate `VICI2_KEK_V2`. Set in env. Restart api (rolling).
2. Run `make rewrap-keks FROM=1 TO=2` — iterates `sip_credentials WHERE
   kek_version=1` in batches of 500, calls `rewrapAll`.
3. Once `SELECT COUNT(*) FROM sip_credentials WHERE kek_version=1` is 0,
   set `VICI2_KEK_CURRENT_VERSION=2`. Restart api.
4. After 30 days (compliance retention for "what-was-the-old-key"
   forensics), remove `VICI2_KEK_V1`.
5. On compromise: skip the wait, rotate immediately, force agent
   password reset, rotate all SIP passwords (FS reload).

---

## 5. SIP credential serving (Phase 1)

### 5.1 What we serve, where

- Static XML directory under `/etc/freeswitch/directory/<domain>/<user_id>.xml`
  (mounted in the FS container; F03 owns the dialplan side).
- **Cleartext SIP password lives on disk inside the FS container only.**
  File mode `0640 root:freeswitch`. Encrypted root volume in any non-dev
  deployment. **Never committed to git** (F01 `.dockerignore` already
  blocks `freeswitch/conf/directory/default/*.xml` except `.gitkeep`).

### 5.2 Render pipeline

`api/src/services/fs-directory-renderer.ts` (function, not a long-running
process):

1. On user create / `auth/sip/rotate` / user update:
   - Load `users` + `sip_credentials` rows.
   - `decrypt(...)` the ciphertext blob → plaintext password.
   - Render XML using a Mustache-like template (no template-injection
     surface; values escaped via `xmlEscape`).
   - Write `freeswitch/conf/directory/<domain>/<user_id>.xml.tmp`,
     `fsync`, atomic rename to `<user_id>.xml`. (`copy_file_range` not
     needed; ext4 rename is atomic.)
2. **Single-flight queue** keyed by `user_id` (Bull-lite via Valkey lock)
   — concurrent admin updates serialize to avoid torn writes.
3. Trigger ESL `reloadxml` once per write (debounced 250 ms via in-process
   timer; multiple sequential writes coalesce). T01 owns the ESL client;
   F05 calls `eslClient.api('reloadxml')`.
4. Audit `auth.sip.rotate` (or `user.create` / `user.edit`) event.

### 5.3 XML template (FROZEN for Phase 1)

```xml
<include>
  <user id="{{user_id}}">
    <params>
      <param name="password" value="{{sip_password}}"/>
      <param name="vm-password" value="{{user_id}}"/>
    </params>
    <variables>
      <variable name="user_context" value="default"/>
      <variable name="effective_caller_id_name" value="{{full_name}}"/>
      <variable name="effective_caller_id_number" value="{{user_id}}"/>
      <variable name="vici2_user_id" value="{{user_id}}"/>
      <variable name="vici2_tenant_id" value="{{tenant_id}}"/>
    </variables>
  </user>
</include>
```

`{{sip_password}}` is XML-escaped. Generated SIP passwords (32 random
chars from `[A-Za-z0-9]`) avoid `<>&"'` so escape is a no-op in
practice — but the escape step is non-negotiable.

### 5.4 Phase-2 migration ticket (filed in HANDOFF)

- Switch `mod_xml_curl` `<bindings/>` (currently empty per F03 PLAN) to
  serve directory XML at runtime from `http://127.0.0.1:3001/fs/directory`.
- API binds the loopback-only port, IP-allowlist `127.0.0.1`, plus
  optional shared-secret header.
- Decrypt DEK on demand, return XML, **no cleartext on disk ever**.
- F03 PLAN already calls this out (§10 of F03 PLAN's note about mod_xml_curl);
  F05 Phase-2 ticket implements the API endpoint.

---

## 6. RBAC model

### 6.1 Roles (hierarchical + orthogonal)

```
super_admin   ─── multi-tenant operator (Phase 4 SaaS); has *.*
   ↓
admin         ─── tenant-wide; everything except cross-tenant ops
   ↓
supervisor    ─── read across agents in their groups + listen/whisper/barge
   ↓
agent         ─── only their own state and assigned leads

integrator    ─── machine-to-machine (Phase 4 N01); orthogonal axis
                  scoped via API key + per-key permission set
```

Hierarchy via static priority list — `requireRole('supervisor')` admits
`admin` and `super_admin` automatically.

### 6.2 Permission verbs (FINAL Phase-1 set)

| Verb | Default holders | Notes |
|---|---|---|
| `auth:login`, `auth:logout` | self | Anyone authenticated |
| `call:dial` | agent+ | self-context |
| `call:transfer` | agent+ | self-context |
| `call:hangup` | agent+ | self-context |
| `call:hold` | agent+ | self-context |
| `call:listen` | supervisor+ | listen-only on supervised agent |
| `call:eavesdrop` | supervisor+ | alias used by S02 |
| `call:whisper` | supervisor+ | |
| `call:barge` | supervisor+ | |
| `lead:read` | agent+ (own); admin+ (all) | resource-scoped |
| `lead:edit` | agent+ (own); admin+ (all) | |
| `lead:create` | admin+ | |
| `lead:delete` | admin+ | |
| `lead:import` | admin+ | bulk lead import |
| `lead:export` | admin+ | DPA-aware |
| `recording:list` | supervisor+ | |
| `recording:download` | supervisor+; admin: all | |
| `recording:delete` | admin+ | |
| `campaign:read` | supervisor+ | |
| `campaign:edit` | admin+ | |
| `campaign:delete` | admin+ | |
| `campaign:create` | admin+ | |
| `carrier:read` | admin+ | |
| `carrier:edit` | admin+ | |
| `dnc:read` | admin+ | |
| `dnc:edit` | admin+ | |
| `dnc:bypass` | super_admin | tenant DNC bypass for support |
| `audit:view` | super_admin | compliance read-only |
| `user:create` | admin+ | |
| `user:edit` | admin+ | |
| `user:delete` | admin+ | |
| `user:rotate-sip` | admin+; agent self-allowed | |
| `tenant:edit` | super_admin | |
| `sip:credentials:view` | super_admin | for support agents — heavily audited |
| `kek:rotate` | super_admin | (Phase 4) |

Source of truth: **`shared/types/src/rbac.ts`** as a Zod-validated map
`Record<Role, ReadonlyArray<Permission>>` plus the union types
`Role` and `Permission`. `make gen-rbac` writes
`dialer/internal/auth/rbac.go` from this. Both languages compile-fail
on stale derivation.

### 6.3 Tenant scoping (HARD RULE)

Every persisted row has `tenant_id` (F02 contract). Every JWT carries
`tenant_id`. Middleware (`requireTenant`) compares JWT `tenant_id` against
the route's `:tenant_id` (or against the resource the handler is about to
load). No handler is permitted to bypass.

**CI enforcement:**
- A grep test in CI scans `api/src/routes/**/*.ts` for any `fastify.get|post|put|patch|delete` registration that doesn't include `requireAuth` (or its alias) in `preHandler`. Fails the build on hit.
- A second grep in `api/src/services/**/*.ts` scans for raw Prisma queries on tenant-scoped tables that don't include `tenant_id` in `where`. Allowlist marker comment `// TENANT-SCOPING-EXEMPT: <reason>` satisfies the check.

### 6.4 Self-only routes

`requireOwn(extractor)` middleware where `extractor(req)` returns the
target resource's `user_id`. Compares to `req.auth.uid`. Admin+ bypasses
the self-check.

Examples: `POST /api/auth/sip/rotate` (self or admin),
`GET /api/agent/me`, `PATCH /api/users/:id` (self or admin).

---

## 7. Permission middleware (Fastify)

### 7.1 File: `api/src/auth/middleware.ts`

Exported decorators (composable via `@fastify/auth`):

```ts
requireAuth                       // verify JWT, attach req.auth
requireRole(role: Role)           // hierarchical
requirePermission(perm: Permission)
requireTenant(extractor?)         // default: req.params.tenant_id || req.body.tenant_id
requireOwn(extractor)             // self-or-admin
requireTotp                       // (Phase 2 hook; in Phase 1: pass-through if user.totp_required is false)
requireWsToken                    // aud === "ws" (used by A03)
```

`req.auth` shape after `requireAuth`:
```ts
type Auth = {
  uid: number;           // users.id
  tenantId: number;
  role: Role;
  perms: Set<Permission>;
  jti: string;
  totpVerified: boolean;
  rawClaims: AccessTokenClaims;
};
```

### 7.2 Composition pattern

```ts
fastify.register(routes, {
  preHandler: fastify.auth([
    fastify.requireAuth,
    fastify.requireTenant(),
    fastify.requirePermission('campaign:edit'),
  ], { relation: 'and' }),
});
```

### 7.3 Always-on global hooks

- `requireTenant` is registered as a `fastify.addHook('onRequest', ...)`
  on every route prefix EXCEPT the `/auth/login`, `/auth/refresh`,
  `/auth/.well-known/jwks.json`, `/health`, `/metrics` allowlist.
- `requireAuth` similarly pre-pended on every prefix except the same
  allowlist.

---

## 8. WebSocket auth (A03 integration)

### 8.1 Initial handshake — query param

**Decision:** `?token=<aud=ws JWT>` query param.

**Rationale (overrides RESEARCH §6.1's subprotocol preference):**
- A01 PLAN (already approved upstream of F05) selected query-param after
  testing: `Sec-WebSocket-Protocol` token-as-subprotocol breaks in
  several browser versions when the token contains `=` padding (base64
  artifact) and conflicts with proper subprotocol negotiation for
  application protocols.
- Mitigation for query-string-in-logs: tokens are **15-min ws-scoped**
  (`aud="ws"`) and revocable on rotation. `wss://` ensures TLS-confidential
  in transit. Reverse proxies (O05) configured to drop `?token=` from
  access logs.

### 8.2 Re-auth without disconnect

1. Server tracks `expires_at` per socket on connect.
2. **2 minutes pre-expiry**, server pushes
   `{op: 'auth-rotate-required', expires_at}`.
3. Client requests new ws-scoped JWT via `POST /auth/ws-token` (uses the
   live `aud="api"` access token; server mints a new `aud="ws"` 15-min
   token).
4. Client sends `{op: 'auth-rotate', token: '<new>'}` over WS.
5. Server verifies (`requireWsToken` logic), updates `expires_at`,
   responds `{op: 'auth-rotated'}`. **Socket persists** — no SIP.js
   churn.

### 8.3 Per-message authorization

JWT verified once at handshake; per-message ops re-check
`req.auth.perms.has(verb)` from the **socket-attached** state
(no re-verify per message). On `auth-rotate`, perms refresh from new
token.

### 8.4 SIP.js WSS leg is independent

Browser opens `wss://fs.example.com:7443` directly to F03's `wss`
profile. Auth = SIP digest with `sip_password` (issued at login by F05).
JWT not in this path. Compromise of SIP password ≠ API access.

---

## 9. Audit log integration

### 9.1 Writer: `api/src/auth/audit.ts`

Single function:
```ts
async function audit(opts: {
  tx: PrismaTransaction;          // REQUIRED — same tx as the action being audited
  actorUserId: number | null;
  actorKind: 'user' | 'system' | 'worker' | 'external_api';
  action: string;                 // see §9.2 catalog
  entityType: string;             // 'user' | 'sip_credential' | 'session' | ...
  entityId: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}): Promise<void>;
```

Calls Prisma `auditLog.create` inside the **caller's transaction**. Per
F02 PLAN §4.5, the `vici2_app` MySQL grant is **INSERT, SELECT only** on
`audit_log` — `UPDATE` and `DELETE` are revoked at the DB layer.
Schema migrations run as `vici2_root`.

### 9.2 Auth event catalog (FROZEN)

| `action` | Severity | When |
|---|---|---|
| `auth.login.success` | info | login OK |
| `auth.login.failure` | warn | bad credentials, unknown user, locked account |
| `auth.logout` | info | explicit logout |
| `auth.logout.all` | warn | logout-all-sessions (admin force or self) |
| `auth.refresh.success` | info | refresh rotated OK |
| `auth.refresh.expired` | info | expired token presented |
| `auth.refresh.reuse_detected` | **page** | family revoked; alarm fires |
| `auth.lockout.triggered` | warn | lockout engaged |
| `auth.lockout.released` | info | back-off elapsed |
| `auth.password.changed` | info | self change |
| `auth.password.reset_requested` | info | reset email queued |
| `auth.password.reset_completed` | info | new password set via reset link |
| `auth.totp.enrolled` | info | (Phase 2 — F06) |
| `auth.totp.verified` | info | (Phase 2 — F06) |
| `auth.totp.failed` | warn | (Phase 2 — F06) |
| `auth.role.changed` | warn | admin promoted/demoted user |
| `auth.user.created` | warn | admin created user |
| `auth.user.deleted` | warn | admin deleted user |
| `auth.user.activated` / `.deactivated` | warn | |
| `auth.sip.rotated` | info | password rotated, new XML rendered |
| `auth.sip.viewed` | warn | super_admin viewed plaintext SIP password |
| `auth.kek.rotation_started` / `.completed` | warn | (Phase 1 manual; Phase 4 auto) |
| `auth.jwt.keys.rotated` | warn | new `kid` activated |
| `auth.jwks.served` | (no-log) | high volume; not audited |

### 9.3 No-secrets rule

CI grep step (added to F01's CI workflow via O04 hand-off):
- Forbidden substrings in any commit on the auth/audit/log paths:
  `sip_password`, `passwordHash`, `password_hash`, `dek_wrap`, `Bearer ey`,
  `VICI2_JWT_PRIVATE_KEY`, `VICI2_KEK_V`, `VICI2_PASSWORD_PEPPER`,
  `argon2id$`.
- `.gitleaks.toml` rules also enforce.
- Allowlist for the encryption helper itself via `// SECRETS-OK: <reason>`
  comment marker.

---

## 10. 2FA scope (DEFERRED to F06)

### 10.1 What F05 ships (hooks only)

Schema additions (F02 amendment, non-breaking):
- `users.totp_required BOOLEAN NOT NULL DEFAULT FALSE`
- `users.totp_enrolled_at DATETIME(6) NULL`
- New table `user_totp_secrets` (created by F06; F05 migration leaves a
  stub comment in `schema.prisma`).

Middleware:
- `requireTotp` — Phase 1 behavior: pass-through if
  `user.totp_required = false`; if true, returns 403 `TOTP_NOT_ENROLLED`
  (F06 implements the actual challenge flow).

Session state:
- Access token claim `totp_verified: boolean`. Phase 1 always `true`
  (since `totp_required` defaults to false). Phase 2 sets to `false` on
  login if `totp_required = true`, then `true` after a successful TOTP
  challenge inside the session.

### 10.2 Phase 2 (F06)

- **TOTP** (RFC 6238): 30-s step, SHA-1 (Google Authenticator compat),
  ±1 step drift, 160-bit secret stored encrypted via §4 helpers, 10
  single-use backup codes (argon2id-hashed at rest).
- **Mandatory** for `admin` and `super_admin`. Optional for
  `supervisor`. Off by default for `agent` (UX volume).
- Enrollment via `otpauth://totp/...` URI + QR code.

### 10.3 Phase 3 (F06 follow-up)

- **WebAuthn / FIDO2** via `@simplewebauthn/server`.
- Replaces TOTP for `super_admin`; coexistence supported.
- Resident credentials enable passwordless flow (Phase 4+).

---

## 11. KMS scope (DEFERRED to Phase 4)

### 11.1 Phase 1

- KEK in env (`VICI2_KEK_V1`, ...). Documented operator constraint.
- Rotation = manual rewrap (§4.7).

### 11.2 Phase 4

- **HashiCorp Vault Transit** primary (preferred for self-hostability).
- **AWS KMS** secondary (for cloud-only deployments that prefer it).
- KEK never leaves the secure enclave; all encryption/decryption
  becomes RPC.
- Provider selected via env `VICI2_KEK_PROVIDER=env|vault|kms`.
- `encryption.ts` interface unchanged — implementation swaps.

### 11.3 Migration path (env → vault)

Runbook (deliverable in F05/HANDOFF for Phase-4 reference):
1. Stand up Vault, create `transit/keys/vici2-kek-v1` with the same
   bytes as `VICI2_KEK_V1`.
2. Set `VICI2_KEK_PROVIDER=vault`. Restart api.
3. All decrypts now go via Vault `decrypt`. No row rewrap needed (DEK
   wrap format unchanged).
4. Rotate to a Vault-internal-only `vici2-kek-v2`, run §4.7 rewrap,
   delete `VICI2_KEK_V1` from env.

---

## 12. CSRF posture

### 12.1 Default — header-only Bearer JWT

- All browser API calls send `Authorization: Bearer <access_token>`.
- Access token lives in JS memory (never `localStorage`, never
  `sessionStorage`).
- Refresh token also returned in the JSON body; client persists it in
  memory and re-issues `/auth/refresh` calls. **No cookies = no CSRF
  surface.**
- A01 has confirmed this is the chosen path.

### 12.2 Cookie fallback (documented, not implemented in Phase 1)

If a future audience requires cookie-based auth (e.g., third-party
embed):
- httpOnly+Secure+SameSite=Strict refresh cookie at `/auth/refresh`.
- Double-submit token: server sets `X-CSRF` cookie (non-httpOnly) +
  client sends `X-CSRF` header on every state-changing request. Server
  compares.
- Document but **do not ship in Phase 1**.

---

## 13. Initial bootstrap (super-admin)

### 13.1 Makefile target

```
make db-bootstrap-superadmin
```

Backed by `api/src/scripts/bootstrap-superadmin.ts`:
1. Reads env: `BOOTSTRAP_SUPERADMIN_EMAIL`, `BOOTSTRAP_SUPERADMIN_PASSWORD`.
   Fails loudly if absent (no defaults).
2. Connects to DB.
3. Idempotent:
   ```
   if user with role=super_admin exists → exit 0 ("already bootstrapped")
   else → create user with hashed password, log audit event
   actor_kind='system', generate sip_credentials row with random password,
   render FS XML.
   ```
4. Prints the user_id, never the password.

### 13.2 Wiring

- **Dev:** `make dev` calls `make db-bootstrap-superadmin` automatically
  if `BOOTSTRAP_SUPERADMIN_EMAIL` is set in `.env`.
- **Prod:** operator runs once, manually, after first `db-deploy`.

### 13.3 F02 cross-check

F02 PLAN §0 bullet 8 mentions a super-admin seed user "whose initial
password is read from `VICI2_BOOTSTRAP_ADMIN_PASSWORD` env." **F05
amendment to F02:** rename the env to `BOOTSTRAP_SUPERADMIN_PASSWORD`
for consistency with the matching `_EMAIL` var, and move the actual
user creation from F02's seed script into the F05 bootstrap script
(so the password gets hashed via F05's argon2id helper rather than F02
seed inserting a placeholder hash). Coordinated at orchestrator level.

---

## 14. Code structure (FROZEN file list)

### 14.1 TypeScript (api)

```
api/src/auth/
  jwt.ts                      — sign/verify (jose), JWKS lookup, kid rotation
  argon2.ts                   — hash/verify with @node-rs/argon2 + pepper + rehash-on-login
  encryption.ts               — AES-GCM envelope, blob layout, AAD, KEK lookup
  refresh.ts                  — Valkey-backed family-tracked rotation (calls Lua)
  rbac.ts                     — re-export of shared/types Permission/Role + helpers
  audit.ts                    — single `audit()` writer (in-tx)
  password-policy.ts          — length check + HIBP k-anonymity client + cache
  lockout.ts                  — Valkey-backed lockout state + back-off math
  middleware.ts               — requireAuth/Role/Permission/Tenant/Own/Totp/WsToken
  sip-creds.ts                — generate (32-char RNG), encrypt, decrypt, rotate
  index.ts                    — barrel export

api/src/auth/lua/
  refresh_consume.v1.lua      — atomic GETDEL + family-revoke

api/src/routes/auth/
  login.ts                    — POST /api/auth/login
  refresh.ts                  — POST /api/auth/refresh
  logout.ts                   — POST /api/auth/logout
  logout-all.ts               — POST /api/auth/logout-all
  me.ts                       — GET  /api/auth/me
  sip-rotate.ts               — POST /api/auth/sip/rotate
  jwks.ts                     — GET  /auth/.well-known/jwks.json
  ws-token.ts                 — POST /auth/ws-token
  password-change.ts          — POST /api/auth/password/change
  password-reset-request.ts   — POST /api/auth/password/reset/request
  password-reset-complete.ts  — POST /api/auth/password/reset/complete

api/src/services/
  fs-directory-renderer.ts    — render XML, atomic write, debounced ESL reload

api/src/scripts/
  bootstrap-superadmin.ts     — make target backend
  calibrate-argon2.ts         — make target backend
  rewrap-keks.ts              — KEK rotation tooling

api/test/auth/
  jwt.test.ts
  argon2.test.ts
  encryption.test.ts          — deterministic IV harness for round-trip + AAD-swap rejection
  refresh.test.ts             — including reuse-detection + family revocation
  rbac.test.ts                — every (role × verb) cell
  middleware.test.ts          — Fastify integration
  password-policy.test.ts     — HIBP mocked
  lockout.test.ts
  sip-creds.test.ts           — encrypt/decrypt round-trip + AAD failure
  fs-directory-renderer.test.ts — atomic rename + ESL stub
  routes/login.test.ts ...    — one per route
  scripts/bootstrap-superadmin.test.ts
```

### 14.2 Go (dialer)

Read-only verifier — dialer doesn't issue, just verifies for any HTTP
API surface it exposes (heartbeat endpoint, future supervisor-side
controls).

```
dialer/internal/auth/
  jwt.go                      — verify with golang-jwt/jwt/v5 + JWKS HTTP cache (60s)
  rbac.go                     — code-generated mirror of shared/types matrix
  middleware.go               — chi middleware: RequireAuth, RequireRole, RequirePermission, RequireTenant
  context.go                  — auth.FromContext(ctx) helper
  jwt_test.go
  rbac_test.go                — matches TS matrix bit-for-bit
  middleware_test.go
```

### 14.3 Shared

```
shared/types/src/
  rbac.ts                     — single source of truth: Role, Permission, Role→Permission map
  auth-claims.ts              — AccessTokenClaims, RefreshRecord types

shared/lua/
  refresh_consume.v1.lua      — copy of api/src/auth/lua/... (deduplicate via build step OR
                                publish from one location; PLAN: source of truth in shared/lua,
                                api imports via fs.readFileSync at boot)
```

`make gen-rbac` reads `shared/types/src/rbac.ts`, emits
`dialer/internal/auth/rbac.go`, fails CI if uncommitted diff.

---

## 15. Hand-off interfaces (frozen)

### 15.1 Amendment to F01 (env vars)

Add to `.env.example`:
```bash
# === F05 Auth ===
VICI2_JWT_PRIVATE_KEY_JWK=             # base64 of JSON JWK; gen via scripts/gen-jwt-keys.sh
VICI2_JWT_PUBLIC_KEYS_JWKS=            # base64 of JSON JWKS (current + grace public keys)
VICI2_JWT_ALG=EdDSA                    # or RS256 (fallback)
VICI2_KEK_V1=                          # base64 of 32 random bytes
VICI2_KEK_CURRENT_VERSION=1
VICI2_PASSWORD_PEPPER=                 # base64 of 32 random bytes
HIBP_OFFLINE=false                     # set true for air-gapped install (skips HIBP check)

BOOTSTRAP_SUPERADMIN_EMAIL=
BOOTSTRAP_SUPERADMIN_PASSWORD=         # consumed once by `make db-bootstrap-superadmin`, then unset
```

Also: replace F01's `API_JWT_SECRET` / `API_JWT_REFRESH_SECRET` placeholder
vars with the EdDSA pair above. F01 IMPLEMENT picks this up before the
auth code lands; coordinated at orchestrator level.

### 15.2 To A01 (browser auth flows)

- `POST /api/auth/login` returns
  `{ access_token, refresh_token, user, sip_creds: {username, password, ws_uri, domain} }`.
- Access token in memory only.
- WS handshake uses `wss://...?token=<aud=ws JWT minted via /auth/ws-token>`.
- Refresh proactive 60 s before access expiry.
- `auth-rotate-required` push handled per §8.2.

### 15.3 To M01 (admin UI)

- Same login flow; admin gets 7-d refresh + `requireRole('admin')` on all
  admin routes.

### 15.4 To D01–D06, T01, T02, etc. (server modules)

- Import `requirePermission(verb)` from `api/src/auth/middleware.ts` and
  attach in `preHandler`.
- For tenant scoping: `requireTenant()` is auto-applied via global hook
  (no opt-in needed).
- For self-only routes: `requireOwn(req => req.params.userId)`.

### 15.5 To T01 (ESL bridge)

- F05 calls `eslClient.api('reloadxml')` after FS XML write. T01 must
  expose this method idempotently.

### 15.6 To C03 (audit immutability)

- F05 produces audit rows via `audit()` writer.
- C03 enforces immutability via DB grant (already in F02 PLAN) + S3
  archive (separate C04 job).

### 15.7 To O01 (observability)

- Prom metrics emitted by F05 module:
  - `vici2_api_auth_login_total{outcome="success|failure|locked"}`
  - `vici2_api_auth_refresh_total{outcome="success|reuse|expired|notfound"}`
  - `vici2_api_auth_argon2_duration_seconds{op="hash|verify"}` (histogram)
  - `vici2_api_auth_encryption_duration_seconds{op="encrypt|decrypt"}`
  - `vici2_api_auth_decrypt_cache_hits_total`
  - `vici2_api_auth_jwks_served_total`
  - `vici2_api_auth_lockout_active_gauge`
  - `vici2_api_auth_kek_rewrap_progress{from_version,to_version}`

### 15.8 To O05 (security baseline)

- Reverse proxy must drop `?token=` from access logs (§8.1).
- TLS termination must enforce TLS 1.2+ (F03 already requires this for
  WSS).
- `gitleaks` config additions per §9.3.

---

## 16. Testing strategy

### 16.1 Unit tests

- **JWT:** sign/verify happy path; tampered sig → reject; expired →
  reject; wrong `iss` / `aud` / `kid` → reject; missing claim → reject.
- **Argon2id:** hash + verify; wrong password → false; rehash on
  param-bump; pepper rotation simulation.
- **Encryption:** round-trip (deterministic IV via injected RNG for the
  test); AAD swap attack → GCM-auth failure; KEK-version mismatch →
  reject; layout-byte parser unit test.
- **RBAC:** every `(role × verb)` cell against the static matrix.
- **Refresh Lua:** unit test under a real Valkey via testcontainers —
  empty hopper → NOT_FOUND; valid → OK; reuse → REUSE_DETECTED + family
  count; concurrent consume → only one OK.
- **HIBP client:** k-anonymity request shape, parse response, cache hit
  / miss.
- **Lockout math:** back-off ladder edges.
- **FS XML renderer:** template escape, atomic rename, ESL reload
  triggered.

### 16.2 Integration tests (against real Valkey + MySQL via docker-compose)

- **Login → me → refresh → me → logout cycle.**
- **Wrong-password lockout** triggers on 6th attempt; back-off ladder
  observed across runs.
- **Refresh-token replay** rejected; family revoked; second refresh of
  any sibling token fails.
- **SIP-rotate** writes new XML, decrypt round-trip OK, ESL reload
  stubbed.
- **Bootstrap superadmin** is idempotent.
- **JWKS rotation** dual-key publication: tokens signed by old kid still
  verify after current-key swap.

### 16.3 Security tests

- **Token replay across users** (forge `uid` claim with wrong sig) → reject.
- **Token replay across audiences** (use `aud=api` token at WS endpoint)
  → reject.
- **Refresh family pinning** (a token from family A presented at the
  refresh endpoint with another family's `family_id` parameter) → reject.
- **AAD swap** on stored ciphertext → decrypt fails.
- **KEK-version downgrade** (try forcing `kek_version=0`) → reject.
- **Lockout bypass via case-difference username** (`Agent01` vs
  `agent01`) → both hit the same lockout key (lowercased).

### 16.4 Coverage target

≥ 90 % on `api/src/auth/**` (per F05 acceptance criteria). Tracked by
`vitest --coverage`.

### 16.5 Run commands

```
make test-auth         # runs unit + integration in api package
cd api && pnpm exec vitest run test/auth
cd dialer && go test ./internal/auth/...
```

---

## 17. Risks & open questions

### 17.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **JWKS exposure** publishing too much | Low | High | Endpoint serves **public keys only**; admin-only `/auth/keys/rotate` (Phase 2). |
| **DEK decryption latency under burst** | Medium | Low | 30-s LRU cache of decrypted DEKs; pre-warm at boot for top-N most-active SIP users. |
| **HIBP API rate-limit / outage** | Medium | Low | 24-h negative cache; on outage, **fail-open** with audit warning (configurable to fail-closed in Phase 4). |
| **Cleartext SIP passwords on disk (Phase 1)** | High | Medium | Documented; encrypted root volume + `0640` mode + Phase-2 ticket to migrate to xml_curl. |
| **EdDSA support in some browser/embedded clients** | Low | Medium | RS256 fallback documented; switch via env. |
| **Argon2 memory pressure under login storm** | Low | Medium | `m=19 MiB × concurrent_logins` ≤ Node heap; lockout caps storm size. Monitor `vici2_api_auth_argon2_duration_seconds`. |
| **Refresh Lua KEYS scan for family revoke** | Low | Low | Family stored as a SET (`auth:refresh:family:{family_id}`), not a `KEYS *` scan. SET cardinality ≤ ~30 (one per rotation in a 30-day window). |
| **F02 schema drift** (`sip_credentials` shape) | Low | High | F05 PLAN matches F02 PLAN §4.4 exactly; any change is coordinated. |
| **Bootstrap env leakage** (`BOOTSTRAP_SUPERADMIN_PASSWORD` lingers) | Medium | Medium | Bootstrap script logs reminder to unset env var; `.env.example` comment instructs same. |
| **CI grep false positives** | Low | Low | Allowlist marker comments (`// SECRETS-OK`, `// TENANT-SCOPING-EXEMPT`) with required justification text. |

### 17.2 Open questions

All RESEARCH §10 questions are now resolved by this PLAN. The four
deferred items (Phase-4 KMS provider, WebAuthn vs TOTP, integrator-role
shape, audit retention tier) are owned by F06 / N01 / C03/C04 — F05
ships hooks/stubs and the schema is forward-compatible.

---

## 18. RFCs filed

**Zero RFCs filed by this PLAN.** All decisions derive from RESEARCH +
upstream PLAN constraints (F01–F04). The PLAN explicitly:

- **Overrides RESEARCH §6.1 (subprotocol header preference)** in favor
  of query-param WS auth, citing A01 PLAN's empirical decision and
  same-token-rotation mitigations.
- **Reverses F03 PLAN's Phase-1 mod_xml_curl emptiness for SIP
  credentials** by making it a Phase-2 ticket (no F03 PLAN change; F03
  PLAN already left bindings empty).
- **Amends F02 PLAN seed**: rename `VICI2_BOOTSTRAP_ADMIN_PASSWORD` →
  `BOOTSTRAP_SUPERADMIN_PASSWORD` and move user creation into F05's
  bootstrap script. This is a coordination note, not an RFC — F02 is
  pre-IMPLEMENT and the change is mechanical.
- **Amends F01 PLAN env vars**: replaces `API_JWT_SECRET` /
  `API_JWT_REFRESH_SECRET` with the EdDSA-key + KEK + pepper trio
  documented in §15.1. F01 IMPLEMENT picks up before auth code lands.

If during IMPLEMENT any of these amendments meets pushback from an
upstream module owner, RFC-002 (Auth env-var conventions) and/or
RFC-003 (WebSocket token transport) are pre-flagged as the natural
landing spots — but neither is required to start IMPLEMENT.

---

## 19. Acceptance criteria (from F05.md, restated against this PLAN)

- [ ] All endpoints behave per OpenAPI spec (§14.1 routes).
- [ ] **Argon2id** with documented parameters (§3); calibration script
      ships; pepper enabled.
- [ ] **SIP creds AES-GCM-256 envelope-encrypted at rest** (§4); blob
      layout matches §4.5.
- [ ] FS directory file generated and reload triggered on user
      create/update/rotate (§5).
- [ ] **Refresh tokens rotate; reuse rejected** with family revoke
      (§2).
- [ ] **Rate limiting + audit logs** on auth events (§3.5, §9).
- [ ] **RBAC enforced via middleware** on every protected route — no
      manual role checks in handlers (§7); CI grep test enforces.
- [ ] All test cases pass; **coverage ≥ 90 %** on `api/src/auth/**`
      (§16.4).
- [ ] **No secrets logged** (verified by grep CI step) (§9.3).
- [ ] Schema additions (`users.totp_required`, `auth_config`) merged
      via F02 amendment.
- [ ] `.env.example` extended per §15.1.
- [ ] Hand-off doc (HANDOFF.md) ships KEK-rotation runbook + Phase-2
      xml_curl migration ticket + Phase-4 KMS migration runbook.

---

End of PLAN.md.
