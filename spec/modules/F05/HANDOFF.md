# F05 — HANDOFF

**Module:** F05 (Foundation, Phase 1) — Auth + RBAC + SIP credential storage
**Status:** IMPLEMENTED on `feat/F05-implement`
**Unblocks:** A01, A02, M01, T02, C03, every protected API route.

## 1. API surface (FROZEN for downstream consumers)

### 1.1 Public routes (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/auth/.well-known/jwks.json` | Public-key set (current + grace). Cache-Control 5 min. CORS open. |
| `POST` | `/api/auth/login` | Body: `{ tenant_id?, username, password }` → `{ access_token, refresh_token, family_id, access_expires_at, refresh_expires_at, user, totp_required }` |
| `POST` | `/api/auth/refresh` | Body: `{ refresh_token, family_id, tenant_id? }` → same shape as login. Reuse → 401 `refresh_reuse_detected`. |

### 1.2 Authenticated routes (Bearer `Authorization: Bearer <jwt>`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/auth/me` | Returns the authenticated user + perms. |
| `POST` | `/api/auth/logout` | Body: `{ family_id? }`. Revokes given family. |
| `POST` | `/api/auth/logout-all` | Revokes every refresh family for the caller. |
| `POST` | `/api/auth/password/change` | Body: `{ current_password, new_password }`. Revokes all sessions on success. |
| `POST` | `/api/auth/sip/rotate` | Body: `{ user_id? }` (self if absent; admin+ for others). Generates + stores a new 32-char SIP password. Returns cleartext **once**. |
| `POST` | `/api/auth/totp/enroll` | Returns `{ secret, otpauth_uri, backup_codes }` for QR. **Caller persists secret** until F06 ships the schema. |
| `POST` | `/api/auth/totp/verify` | Body: `{ secret, code }` → `{ verified: true }`. Phase 1 stateless verify; F06 ties secret to the user row. |
| `POST` | `/auth/ws-token` | Mint a 15-min `aud="ws"` JWT from a live `aud="api"` token. |

### 1.3 Access-token claim shape

```json
{
  "iss": "vici2-api",
  "aud": "api" | "ws",
  "sub": "u_<id>",
  "uid": 42,
  "tenant_id": 1,
  "role": "agent" | "supervisor" | "admin" | "super_admin" | "integrator",
  "perms": ["call:dial", "..."],
  "iat": 1746500000,
  "exp": 1746500900,
  "jti": "uuid-v4",
  "totp_verified": true
}
```

Header `{ alg: "EdDSA", kid: "ed25519-2026-1", typ: "JWT" }`.

### 1.4 Middleware decorators (consumed via `import` of `api/src/auth/middleware.ts`)

After `await registerAuthDecorators(app)`:

```ts
app.requireAuth                       // verify JWT (aud=api), attach req.auth
app.requireWsToken                    // verify JWT (aud=ws)
app.requireRole(role)                 // hierarchical (super_admin > admin > supervisor > agent)
app.requirePermission(perm)           // checks req.auth.perms (token-embedded or role default)
app.requireTenant(extractor?)         // default extractor: params.tenant_id / body.tenant_id
app.requireOwn(extractor)             // self-or-admin
app.requireTotp                       // 403 if !req.auth.totpVerified (F06 fills in)
```

`req.auth` after `requireAuth`:

```ts
type Auth = {
  uid: number;
  tenantId: number;
  role: Role;
  perms: Set<Permission>;
  jti: string;
  totpVerified: boolean;
  rawClaims: AccessTokenClaims;
};
```

### 1.5 RBAC matrix

Single source of truth: `shared/types/src/rbac.ts`. 35 permission verbs. Hierarchy:

```
super_admin (40) > admin (30) > supervisor (20) > agent (10)
integrator (0) — orthogonal; never satisfies a hierarchical check
```

Re-exported from `api/src/auth/rbac.ts` for downstream `requirePermission(perm)` calls. Go mirror (`dialer/internal/auth/rbac.go`) is deferred — `make gen-rbac` step will be added when the dialer needs auth (T01-onward).

## 2. Env vars (new, in `.env.example`)

```bash
# JWT — generate with: pnpm exec tsx api/src/scripts/gen-jwt-keys.ts
VICI2_JWT_ALG=EdDSA
VICI2_JWT_ISSUER=vici2-api
VICI2_JWT_PRIVATE_KEY_JWK=<base64(JSON JWK)>
VICI2_JWT_PUBLIC_KEYS_JWKS=<base64(JSON JWKS)>

# AES-GCM envelope encryption — 32 random bytes, base64
VICI2_KEK_V1=<openssl rand -base64 32>
VICI2_KEK_CURRENT_VERSION=1

# Argon2id HMAC pepper — 32 random bytes, base64
VICI2_PASSWORD_PEPPER=<openssl rand -base64 32>

# HIBP — set true for air-gapped installs
HIBP_OFFLINE=false

# Token TTLs (defaults reflect PLAN §1.2)
VICI2_ACCESS_TTL_SEC=900
VICI2_REFRESH_TTL_AGENT_SEC=2592000
VICI2_REFRESH_TTL_ADMIN_SEC=604800
VICI2_REFRESH_TTL_INTEGRATOR_SEC=3600

# Bootstrap (consumed once by `make db-bootstrap-superadmin`)
BOOTSTRAP_SUPERADMIN_EMAIL=admin@example.com
BOOTSTRAP_SUPERADMIN_PASSWORD=<set then unset>
BOOTSTRAP_SUPERADMIN_TENANT_ID=1
```

F01's `API_JWT_SECRET` / `API_JWT_REFRESH_SECRET` placeholders have been removed; the EdDSA pair replaces both. Orchestrator coordinates this — F01 IMPLEMENT picks it up.

## 3. DB tables touched

| Table | Read | Write |
|-------|------|-------|
| `users` | ✓ (login lookup, me, password change) | ✓ (last_login_at, password_hash on rehash, totp_required toggle) |
| `sip_credentials` | ✓ (decrypt for FS XML) | ✓ (create + update on rotate) |
| `audit_log` | — | ✓ INSERT only (per F02 grant) |
| `auth_config` | reserved (Phase 1 reads defaults from env; F02 amendment A3 single-row table is present, populated when Argon2 calibration ships) | — |
| `tenants` | implicit via FK | — |

No schema changes from F05; all needed columns landed in F02 + amendments (A2 `users.totp_required`, A3 `auth_config`, `sip_credentials` already in `0_init`).

## 4. Valkey/Redis keyspace (per F04 convention, DB 0)

| Key pattern | Type | Purpose |
|-------------|------|---------|
| `t:{tid}:auth:refresh:{family_id}:{token_hash}` | HASH | Per-token record (user_id, role, parent_token_hash, expires_at). TTL = refresh TTL. |
| `t:{tid}:auth:refresh:family:{family_id}` | SET | Members = token_hash. TTL = longest member TTL. |
| `t:{tid}:auth:refresh:user:{user_id}` | SET | Members = family_id. Cleaned by `revokeAllForUser`. |
| `t:{tid}:auth:lockout:{username_lower}` | HASH | fail_count, last_fail_at, locked_until, level. TTL 24 h. |
| `cache:hibp:{sha1_prefix}` | STRING | Comma-separated suffix list. TTL 24 h. |

Lua script: `shared/lua/refresh_consume.v1.lua` (canonical) mirrored to `api/src/auth/lua/`. Loader uses `SCRIPT LOAD` + `EVALSHA` with `NOSCRIPT` reload; falls back to plain `EVAL` when the backing server doesn't implement SCRIPT (e.g., ioredis-mock in unit tests).

## 5. Audit events written by F05

All written via `audit({ tx, action, ... })`. Severity column is documentation-only in Phase 1 (no level enum yet).

| Action | When |
|--------|------|
| `auth.login.success` | login OK |
| `auth.login.failure` | bad creds, unknown user, locked |
| `auth.logout` | explicit logout |
| `auth.logout.all` | logout-all |
| `auth.refresh.success` | rotated OK |
| `auth.refresh.expired` | token not found |
| `auth.refresh.reuse_detected` | family revoked (page severity) |
| `auth.lockout.triggered` | lockout engaged |
| `auth.password.changed` | self change |
| `auth.totp.enrolled` / `verified` / `failed` | TOTP flow |
| `auth.sip.rotated` | new SIP password generated |
| `auth.user.created` | bootstrap super_admin |

## 6. Deferred items (Phase 2+)

| Item | Owner | Reason |
|------|-------|--------|
| `fs-directory-renderer.ts` — write `/etc/freeswitch/directory/<domain>/<user_id>.xml`, atomic rename, ESL reload | F05 follow-up | Phase-1 PLAN §5; needs T01 ESL client |
| `make gen-rbac` Go codegen + `dialer/internal/auth/{jwt,rbac,middleware}.go` | T01 / dialer | Dialer doesn't yet expose protected HTTP; mirror lands when needed |
| Argon2 calibration script (`calibrate-argon2.ts`) writing to `auth_config` | F05 follow-up | OWASP defaults applied today; auto-tune is a Day-1+1 polish |
| KEK rotation tooling (`rewrap-keks.ts`) | F05 follow-up | Phase-1 runbook in §7; tool can land later |
| `requireTotp` real enforcement (currently passes through if `user.totp_required=false`) | F06 | Per PLAN §10 |
| HashiCorp Vault Transit / AWS KMS KEK provider | F05 Phase-4 | env-only Phase 1 |
| OAuth client_credentials grant (`/auth/oauth/token`) for integrators | N01 / F05-Phase-4 | Phase 1 stubs return 404 (not yet wired) |
| Password reset (`/auth/password/reset/request|complete`) endpoints | F05 follow-up | Email delivery (W01) not yet shipped; bootstrap is the workaround |
| Force-logout admin endpoint | M01 | RBAC verb `user:edit` covers this; controller lands with admin UI |
| OpenAPI doc generation for F05 routes | N01 | F05 implements; N01 IMPLEMENT emits the spec |
| Prom metrics emission (`vici2_api_auth_*`) | F05 follow-up | counters/histograms declared in PLAN §15.7; instrumentation pass |

## 7. KEK rotation runbook (Phase 1, manual)

```bash
# 1. Provision new KEK
openssl rand -base64 32  # set as VICI2_KEK_V2

# 2. Add to env on every api/workers replica, restart rolling.
#    Both V1 and V2 must be set on all nodes.

# 3. Re-wrap all sip_credentials from V1 to V2 (tooling pending; for now,
#    SELECT rows WHERE kek_version=1 and re-encrypt each in a transaction).

# 4. Once `SELECT COUNT(*) FROM sip_credentials WHERE kek_version=1` is 0:
#    set VICI2_KEK_CURRENT_VERSION=2, restart api.

# 5. Wait ≥30d (forensic retention), then drop VICI2_KEK_V1 from env.
```

## 8. JWT key rotation runbook (Phase 1, manual)

```bash
# 1. Generate new key pair
pnpm exec tsx api/src/scripts/gen-jwt-keys.ts ed25519-2026-2

# 2. Append the new public JWK to VICI2_JWT_PUBLIC_KEYS_JWKS
#    (decode base64, parse JSON, push to keys[], re-encode).
#    Restart api rolling. All replicas now VERIFY old + new.

# 3. After ≥1 deploy cycle:
#    Replace VICI2_JWT_PRIVATE_KEY_JWK with the new private JWK.
#    Restart api. New tokens signed with new kid. Old kid still verifies.

# 4. After max(refresh TTL, 30d):
#    Drop the old public from VICI2_JWT_PUBLIC_KEYS_JWKS. Restart.
```

## 9. CI hooks needed (handed to O04)

- Grep `api/src/routes/**/*.ts` for `fastify.{get,post,put,patch,delete}` that don't include `requireAuth` in `preHandler` (allowlist comment: `// PUBLIC-ROUTE: <reason>`).
- Grep `api/src/services/**/*.ts` for `prisma.<tenant-scoped-model>.{find,update,delete}` without `tenant_id` in the where clause (allowlist comment: `// TENANT-SCOPING-EXEMPT: <reason>`).
- Forbidden-string grep on the auth path (PLAN §9.3): `sip_password`, `password_hash`, `dek_wrap`, `Bearer ey`, `VICI2_JWT_PRIVATE_KEY`, `VICI2_KEK_V`, `VICI2_PASSWORD_PEPPER`, `argon2id$`.
- Both deferred to O04 / F01 IMPLEMENT — they're trivial bash one-liners but need to live next to the existing `check-tenant-index-leadership.sh`.

## 10. Operator commands

```bash
# Generate JWT keys (run once, paste into .env)
pnpm exec tsx api/src/scripts/gen-jwt-keys.ts

# Bootstrap the super_admin user (idempotent; run once after first migrate)
BOOTSTRAP_SUPERADMIN_EMAIL=admin@example.com \
BOOTSTRAP_SUPERADMIN_PASSWORD='supersecure-12-chars-min!' \
pnpm exec tsx api/src/scripts/bootstrap-superadmin.ts

# Run the F05 test suite
cd api && pnpm test
cd api && pnpm exec vitest run --coverage
```
