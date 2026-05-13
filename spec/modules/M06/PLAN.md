# M06 — Carrier / Gateway / DID Admin UI — PLAN

**Module:** M06 (Admin UI for Carrier Management)
**Author:** M06-IMPLEMENT agent
**Date:** 2026-05-13
**Status:** IMPLEMENTED
**Branch:** feat/M06-implement
**Depends on:** T02 (schema + carriers/gateways/dids tables), F05 (DEK encryption), F03 (sofia profile), M01 (admin shell)

---

## 0. TL;DR

M06 ships the operator-facing CRUD UI for the three telephony tables introduced
by F02/T02: `carriers`, `gateways`, and `did_numbers`. It adds:

- 6 REST route files under `/api/admin/carriers`, `/api/admin/dids`
- 3 Zod schema files (carrier, gateway, did)
- 3 service files (carrier service, gateway service, did service)
- 2 action files (test-connect, gateway-reload via Redis pub/sub)
- Web pages: `/admin/carriers/*` and `/admin/dids/*`
- Web components: CarrierTable, CarrierForm, GatewayTable, GatewayForm, DidTable, DidForm, DidBulkModal
- Tests: schema unit tests + service mock tests

---

## 1. Data model recap (T02 + F02 amendments, no new migrations)

### 1.1 Carrier

| Column | Type | Notes |
|--------|------|-------|
| id | bigint PK | auto |
| tenant_id | bigint | multi-tenant |
| name | varchar(64) | unique per tenant |
| kind | CarrierKind | 9-value enum (twilio, telnyx, telnyx_creds, telnyx_ip, signalwire, ringcentral, bandwidth, flowroute, byoc) |
| proxy | varchar(255) | SIP proxy FQDN |
| username_ct | varbinary(512) | AES-GCM ciphertext (F05 envelope) |
| password_ct | varbinary(512) | AES-GCM ciphertext |
| kek_version | smallint | key version for rotation |
| register | boolean | register=true for digest auth |
| caller_id_e164 | varchar(16) | default outbound CID |
| active | boolean | soft-enable |
| ip_allowlist | json | inbound source IP ranges |
| config_json | json | extra per-kind config |
| send_pai | boolean | emit P-Asserted-Identity |
| is_emergency | boolean | E911 carrier flag |
| max_concurrent | int? | carrier-level concurrency cap |
| notes | json | operator memos |
| version | int | optimistic concurrency |

**RBAC:** carriers:read = admin+; carriers:write = super_admin only (credentials
are encrypted DEK — only super_admin may see masked credential status).

### 1.2 Gateway

Per-carrier gateways map 1:M to a carrier. Each becomes one Sofia gateway XML.

| Column | Type | Notes |
|--------|------|-------|
| id | bigint PK | |
| carrier_id | bigint FK | cascade delete |
| name | varchar(64) | unique per tenant; becomes FS gateway name |
| proxy | varchar(255) | Sofia proxy param |
| transport | GatewayTransport | udp/tcp/tls |
| register | boolean | |
| weight | smallint | Phase-2 distributor weight |
| max_concurrent | int? | gateway-level cap |
| version | int | optimistic lock |
| cost_per_min_cents | int? | billing metadata |
| active | boolean | |

**RBAC:** same as carriers (carriers:read / carriers:write).

### 1.3 DID Numbers

| Column | Type | Notes |
|--------|------|-------|
| id | bigint PK | |
| e164 | varchar(16) | E.164 format (+12065551234) |
| carrier_id | bigint FK | |
| route_kind | DidRouteKind | ingroup/ivr/agent/ext/voicemail |
| route_target | varchar(64) | ingroup_id / ivr_id / etc |
| caller_id_name | varchar(64) | CNAM |
| active | boolean | |
| default_lang | varchar(5) | IVR language (en/es/fr) |
| ivr_timeout_sec | smallint unsigned | IVR session timeout |

**RBAC:** dids:read = admin+; dids:write = admin+ (no super_admin restriction).

---

## 2. REST API surface

### 2.1 Carriers

```
GET    /api/admin/carriers                      carriers:read
POST   /api/admin/carriers                      carriers:write
GET    /api/admin/carriers/:id                  carriers:read
PATCH  /api/admin/carriers/:id                  carriers:write
DELETE /api/admin/carriers/:id                  carriers:write

POST   /api/admin/carriers/:id/test-connect     carriers:read (smoke test)

GET    /api/admin/carriers/:id/gateways         carriers:read
POST   /api/admin/carriers/:id/gateways         carriers:write
GET    /api/admin/carriers/:id/gateways/:gwId   carriers:read
PATCH  /api/admin/carriers/:id/gateways/:gwId   carriers:write
DELETE /api/admin/carriers/:id/gateways/:gwId   carriers:write
POST   /api/admin/carriers/:id/gateways/:gwId/reload   carriers:write

GET    /api/admin/carriers/:id/health           carriers:read
```

### 2.2 DIDs

```
GET    /api/admin/dids                   dids:read  (?carrier=X, ?active=true)
POST   /api/admin/dids                   dids:write
GET    /api/admin/dids/:id               dids:read
PATCH  /api/admin/dids/:id               dids:write
DELETE /api/admin/dids/:id               dids:write
POST   /api/admin/dids/bulk              dids:write (CSV multipart)
```

---

## 3. Credential masking

- GET endpoints return `credentialStatus: "set" | "unset"` — never raw bytes
- PATCH with `username` / `password` fields: super_admin only; re-encrypts via
  inline AES-GCM-256 (no F05 package dependency in Phase 1; use `crypto.subtle`
  from Node.js)
- Audit log records `{old_kek_version, new_kek_version}` on credential change
- `kek_version` read from `KEK_VERSION` env var (default 1)

---

## 4. Test-connect action

`POST /api/admin/carriers/:id/test-connect` flow:
1. Load carrier + first active gateway
2. Publish `vici2:freeswitch:sofia:options` to Redis with gateway name
3. Poll Redis key `t:{tid}:carrier:gw_status:{gwId}` up to 5s for a response
4. If no Redis response (dev/test env), return `{ simulated: true, state: "UP" }`
5. Return `{ state, ping_ms, status, simulated }`

This is fire-and-forget in Phase 1 — the ESL worker (T01) handles the actual
OPTIONS probe and writes back the result. If T01 not present, we simulate.

---

## 5. Gateway reload action

`POST /api/admin/carriers/:id/gateways/:gwId/reload`:
1. Publish `vici2:freeswitch:sofia:rescan` to Redis
2. Return `{ queued: true, timestamp }`
3. Audit log: `carrier.gateway.reloaded`

---

## 6. CSV bulk-add for DIDs

`POST /api/admin/dids/bulk` accepts `multipart/form-data` with field `file`
(CSV). Columns: `e164,carrier_id,route_kind,route_target,active,default_lang`.
- Parse with `csv-parse/sync` (already in web deps or use Node built-in split)
- Validate each row with DidCreateSchema
- Upsert on `(tenant_id, e164)` — update if exists, insert if not
- Return `{ inserted, updated, errors: [{row, message}] }`
- Max 10,000 rows per upload

---

## 7. Audit events (C03 chain)

All mutations emit to `audit_log` via the existing `audit()` helper:
- `carrier.created`, `carrier.updated`, `carrier.deleted`
- `carrier.credential.rotated` (with `{old_kek_version, new_kek_version}`)
- `carrier.test_connect` (with `{state, ping_ms}`)
- `carrier.gateway.created`, `carrier.gateway.updated`, `carrier.gateway.deleted`
- `carrier.gateway.reloaded`
- `did.created`, `did.updated`, `did.deleted`
- `did.bulk_imported` (with `{inserted, updated, errors_count}`)

---

## 8. Web pages

```
/admin/carriers              CarriersPage    — list + create button
/admin/carriers/new          NewCarrierPage  — CarrierForm (mode=create)
/admin/carriers/[id]         CarrierDetailPage — tabs: Info / Gateways / Health / DIDs
/admin/dids                  DidsPage        — list + filter by carrier + bulk upload button
/admin/dids/new              NewDidPage      — DidForm (mode=create)
/admin/dids/[id]             DidDetailPage   — DidForm (mode=edit)
```

---

## 9. File manifest

### API (api/src/routes/admin/carriers/)
- `index.ts` — route registration (carriers + gateways endpoints)
- `schema.ts` — Zod schemas: CarrierCreateSchema, CarrierUpdateSchema, GatewayCreateSchema, GatewayUpdateSchema
- `service.ts` — CRUD service functions
- `actions.ts` — testConnect(), reloadGateway()

### API (api/src/routes/admin/dids/)
- `index.ts` — route registration
- `schema.ts` — DidCreateSchema, DidUpdateSchema, DidBulkRowSchema
- `service.ts` — CRUD + bulk import

### Web (web/src/components/admin/)
- `CarrierTable.tsx` — list carriers with gateway count + health badge
- `CarrierForm.tsx` — create/edit carrier form
- `GatewayTable.tsx` — per-carrier gateway list with reload button
- `GatewayForm.tsx` — create/edit gateway form
- `DidTable.tsx` — DID list with carrier/route display
- `DidForm.tsx` — create/edit DID form
- `DidBulkModal.tsx` — CSV upload modal

### Web (web/src/app/(admin)/admin/)
- `carriers/page.tsx`
- `carriers/new/page.tsx`
- `carriers/[id]/page.tsx`
- `dids/page.tsx`
- `dids/new/page.tsx`
- `dids/[id]/page.tsx`

### Tests (api/test/admin/)
- `carriers.schema.test.ts`
- `carriers.service.test.ts`
- `dids.schema.test.ts`

---

## 10. RBAC mapping

| Verb | Minimum role | Notes |
|------|-------------|-------|
| `carrier:read` | admin | maps to requirePermission("carrier:read") |
| `carrier:write` | super_admin | credentials visible as masked |
| `did:read` | admin | |
| `did:write` | admin | |

Phase 1: we use `requireRole("admin")` / `requireRole("superadmin")` from
the existing middleware pattern (same as M01 ingroups.ts pattern) since the
full RBAC verb system for carriers is not yet in the permissions table.
