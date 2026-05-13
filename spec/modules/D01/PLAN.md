# D01 — Lead CRUD Service — PLAN

**Module:** D01 (Data, Phase 1)
**Author:** D01 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 36 citations.
**Depends on (PLANs FROZEN):** F01, F02, F05.
**Blocks:** D02, A04, A05, A06, D06, E01, M03, N01.

This plan converts the D01 RESEARCH findings + the F02 leads schema + the
F05 RBAC matrix into a frozen REST contract, code layout, performance
budget, and test strategy. Once accepted, the public surface (endpoint
shapes, RBAC verbs consumed, cursor format, optimistic-lock wire shape,
event names, OpenAPI slice) is FROZEN. Internal layout (handler order,
helper composition, cache TTL constants) may evolve without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **REST surface = 10 endpoints under `/api/leads`** plus the admin
   `POST /api/lead-fields/:k/index` field-promotion endpoint. Fastify
   routes registered with `fastify-zod-openapi`, contributing the
   `/leads/*` slice of `shared/openapi/openapi.yaml`. Shared Zod
   schemas live in `shared/types/src/lead.ts` (re-exported via
   `@vici2/types`) so `web/`, `workers/`, and the Go dialer's contract
   tests share one source of truth.
2. **Cursor pagination** = `base64url({v:1, k:[modify_at_iso, id]})`,
   opaque, replay-safe via `WHERE (modify_at, id) < (?, ?)`. Total
   counts omitted by default; `?withCount=true` runs a separate
   capped-at-100 000 query gated to admin role.
3. **Optimistic locking** via a new `version SMALLINT NOT NULL DEFAULT 1`
   column on `leads` (F02 amendment, §13). Client sends `If-Match: "<n>"`
   (or body `{ version }`); server runs CAS `UPDATE ... WHERE id=? AND
   tenant_id=? AND version=?`; affected-rows == 0 ⇒ **412 Precondition
   Failed** with `{error:"stale_version", expected, actual}`. ETag
   header mirrors version on every mutating response.
   `If-Unmodified-Since` is **rejected** (clock skew + DATETIME(6)
   precision insufficient).
4. **Bulk endpoint** = `POST /api/leads/bulk`, **cap 500 rows**,
   partial-success **HTTP 207 Multi-Status** with
   `{inserted, skipped, errors:[{row, code, message}]}`. Backed by
   Prisma `createMany({ skipDuplicates: true })` inside a single
   transaction with one `audit_events` "bulk_inserted" row. Optional
   `options.dryRun` validates without insert; `options.strict=true`
   flips to all-or-nothing rollback (default false).
5. **Custom-fields strategy** — Phase 1 stays JSON-only on
   `leads.custom_data` with `?custom.<key>=<value>` filters that
   compile to `JSON_UNQUOTE(JSON_EXTRACT(custom_data,'$."<key>"'))=?`.
   Index promotion via admin endpoint `POST /api/lead-fields/:k/index`
   (super_admin only) — runs raw SQL `ALTER TABLE leads ADD COLUMN
   cf_<k> VARCHAR(255) AS (...) VIRTUAL, ADD INDEX(...)`. Prisma
   doesn't model virtual gen cols; managed via `$executeRawUnsafe`
   wrapper. Per-tenant `lead_custom_fields` table is a documented
   Phase-2 escape hatch.
6. **Phone normalization** uses **`libphonenumber-js/min`** (80 KB
   bundle) at write time on `phone_e164`, `phone_alt`, `phone_alt2`.
   Default country = per-list `country_code` column (US default).
   `parsePhoneNumberFromString(raw, country).number` — invalid input
   rejected with `400 INVALID_PHONE`; sub-validity warnings (legacy
   CRM imports) tolerated as soft warnings on bulk only.
7. **Multi-tenant scoping** delegated entirely to F05's Prisma Client
   Extension + AsyncLocalStorage pattern (already specified in F05
   PLAN §8 / D01 RESEARCH §8). D01 does **not** read `tenantId` from
   query/body — it always comes from `req.auth.tenantId`. Bypass
   requires `// TENANT-SCOPING-EXEMPT: <reason>` marker; CI grep
   blocks any `prisma.lead.*` outside `api/src/leads/` and
   `api/src/system/`.
8. **Rate limiting** via `@fastify/rate-limit` with the F04
   Valkey-backed store, keyed on `(tenant_id, route)` via F05's
   `req.auth.tid`. Per-route caps: `lookup`=600 rpm, `list`=60 rpm,
   `bulk`=10 rpm, `update`=120 rpm, `single create`=120 rpm,
   `withCount`=10 rpm.
9. **Audit log integration** — every mutation writes one
   `audit_events` row inside the same Prisma `$transaction` as the
   entity write (per F05 audit writer §9.1). After commit, publish
   `vici2.lead.{action}` to a Valkey Stream (at-least-once;
   best-effort consumer; the audit_events row is the durable record,
   per RESEARCH §9.3). Outbox-table upgrade path documented; not
   shipped Phase 1.
10. **Performance targets (CI-enforced via k6 in O03)** — single read
    p95 < 50 ms (target 100 ms), 50-row list p95 < 200 ms (target
    500 ms), bulk-500 < 1.5 s, phone lookup < 30 ms. Hit by Prisma
    `select` (no `include` by default), default-omit `custom_data`
    from list, and a 30-s Valkey cache on the list endpoint with
    event-driven invalidation. Lookup path is **never cached**
    (correctness > latency).

---

## 1. REST API surface (FROZEN)

### 1.1 Endpoint table

All routes are mounted under `/api/leads` (with the field-promotion
endpoint under `/api/lead-fields`). All require `requireAuth` +
`requireTenant` global hooks (F05 §7.3). Per-route RBAC is enforced
in `preValidation` via F05's `requirePermission(verb)` decorator.

| Method | Path | RBAC perm (F05) | Purpose |
|---|---|---|---|
| `GET` | `/api/leads` | `lead:read` | list with filters + cursor pagination |
| `GET` | `/api/leads/lookup` | `lead:read` (own if agent) | by phone E.164; agent hot path |
| `GET` | `/api/leads/:id` | `lead:read` (own if agent) | single lead w/ optional `?expand=` |
| `POST` | `/api/leads` | `lead:create` | create one |
| `POST` | `/api/leads/bulk` | `lead:import` | create up to 500 |
| `PATCH` | `/api/leads/:id` | `lead:edit` | update non-status fields (optimistic-locked) |
| `DELETE` | `/api/leads/:id` | `lead:delete` | soft-delete (`deleted_at = NOW(6)`) |
| `GET` | `/api/leads/:id/calls` | `lead:read` | call history (joins `call_log`) |
| `GET` | `/api/leads/export` | `lead:export` | CSV stream (D02 territory; D01 provides hook) |
| `POST` | `/api/lead-fields/:k/index` | `super_admin` only | promote custom field to virtual gen col + index |

**Out-of-scope for D01 (own modules):**
- `POST /api/leads/:id/status` — owned by D04 (status update + agent_log + transition validation)
- `POST /api/leads/:id/recycle` — owned by D06 (callback re-add semantics)
- `POST /api/leads/:id/restore` — soft-delete restore deferred to C04/admin tooling
- `POST /api/leads/bulk-status` — D04 (bulk status mutation joins to statuses table)

D01 ships the GET/PATCH/DELETE primitives those modules build on.

### 1.2 Query parameters on `GET /api/leads`

| Param | Type | Notes |
|---|---|---|
| `list_id` | int \| int[] | scopes to one or many lists |
| `status` | string \| string[] | uppercase 8-char codes |
| `owner_user_id` | int | owner-dialing scope |
| `phone_e164` | string | exact match (use `/lookup` for variants) |
| `state` | string | 2-letter |
| `min_called`, `max_called` | int | `called_count` range |
| `created_after`, `created_before` | ISO8601 | range |
| `modified_after`, `modified_before` | ISO8601 | range |
| `search` | string | last/first/email/vendor_lead_code prefix; ≥3 chars |
| `custom.<key>` | string | JSON-extract equality filter |
| `include_deleted` | bool | admin-only; default false |
| `cursor` | opaque base64 | pagination cursor |
| `limit` | int | default 50, max 200 |
| `sort` | enum | `modify_at_desc` (default), `created_at_desc`, `rank_desc` |
| `expand` | csv | `list,owner` (relation loading; opt-in) |
| `include` | csv | `custom_data` (omitted by default) |
| `withCount` | bool | admin-only; runs separate count query (cap 100 000) |

### 1.3 Response shapes (FROZEN)

**`GET /api/leads`:**
```json
{
  "data": [ { "id": 1742031, "...": "..." } ],
  "page": {
    "limit": 50,
    "has_more": true,
    "next_cursor": "eyJ2IjoxLCJrIjpbIjIwMjYtMDUtMDZUMTQ6MjE6NTUuMTIzNDU2WiIsMTc0MjAzMF19"
  }
}
```

**`POST /api/leads` (201):** body returns the created row; headers
`Location: /api/leads/<id>`, `ETag: "1"`.

**`PATCH /api/leads/:id` (200):** body returns the patched row;
header `ETag: "<new_version>"`. `412` on stale version with
`{error:"stale_version", expected, actual, message}`.

**`POST /api/leads/bulk` (207):**
```json
{
  "inserted": 470,
  "skipped":  25,
  "errors":  [ { "row": 12, "code": "INVALID_PHONE", "message": "..." } ]
}
```

**`DELETE /api/leads/:id`:** `204 No Content`. Idempotent (second call
on already-deleted row also returns 204).

**`GET /api/leads/:id/calls`:** `{ data: CallLogRow[], page }` —
cursor-paginated, joined to `call_log`. Schema lives with D04/T04 but
read-projection is owned by D01.

**`GET /api/leads/export`:** streams `text/csv`; D02 owns column
selection logic, D01 ships the streaming filter pipeline + RBAC gate.

### 1.4 Idempotency

- `POST /api/leads` and `POST /api/leads/bulk` accept
  `Idempotency-Key: <uuid>` header. Server stores the response in
  Valkey at `t:{tid}:idem:lead:{key}` for **24 h**; replay returns
  the cached body verbatim. Required by D02 (CSV importer) + N01
  (webhook ingest) for at-least-once delivery semantics.
- `PATCH` is idempotent via the version check (replay sees same
  version → 200 first, 412 second).
- `DELETE` is idempotent via the soft-delete predicate.

---

## 2. Cursor pagination (FROZEN)

### 2.1 Format

```
cursor = base64url( JSON({ v: 1, k: [ <modify_at ISO8601>, <id> ] }) )
```

- `v` is the version (1 today; bump if `k` shape changes).
- `k` length must match the requested `sort`:
  - `modify_at_desc` (default): `[modify_at_iso, id]`
  - `created_at_desc`: `[created_at_iso, id]`
  - `rank_desc`: `[rank, id]` (offset-mode admin scan; cursor tracks
    the last `(rank, id)` pair rather than offset)

### 2.2 Validation

- Decode failure → `400 INVALID_CURSOR`.
- `v` mismatch → `400 INVALID_CURSOR_VERSION`.
- Sort change mid-pagination (cursor's `k` shape doesn't match
  `?sort=`) → `400 CURSOR_SORT_MISMATCH` — clients must restart.

### 2.3 Query shape (default sort)

```sql
SELECT <selected cols> FROM leads
WHERE tenant_id = ?
  AND deleted_at IS NULL
  AND (modify_at, id) < (?, ?)
  AND <other filters>
ORDER BY modify_at DESC, id DESC
LIMIT 51   -- limit + 1 to compute has_more
```

Index used: `(tenant_id, list_id, status, modify_at)` covers the
hopper-aligned hot path; `(tenant_id, modify_at)` covers the no-list
case. Both per F02 PLAN §4.13.

### 2.4 Limits

- `limit` default **50**, max **200**, `limit=0` rejected.
- D01 spec acceptance criterion ("Pagination ≤ 200 rows / page")
  honored.

### 2.5 Counts

- Default: omitted.
- `?withCount=true` (admin only, rate-limited 10 rpm) runs a separate
  `SELECT COUNT(*)` query gated by a `LIMIT 100001` strategy:
  ```sql
  SELECT COUNT(*) FROM (SELECT 1 FROM leads WHERE ... LIMIT 100001) sub
  ```
  If result > 100 000, response returns
  `{ count_estimate: 100000, count_capped: true }` to avoid table
  scans.

---

## 3. Optimistic locking (FROZEN)

### 3.1 Wire shape

- Header (canonical): `If-Match: "<version>"` (RFC 7232 strong validator).
- Body fallback: `{ "version": <n>, ...patch }`. If both present,
  **header wins**.
- Both strong (`"5"`) and weak (`W/"5"`) ETag tokens accepted on
  parse; we never serve weak.

### 3.2 Server logic

```
PATCH /api/leads/:id  (transactional)

await prisma.$transaction(async (tx) => {
  const before = await tx.lead.findUniqueOrThrow({
    where: { id, tenantId: ctx.tid }
  });
  if (before.version !== expectedVersion) throw new StaleVersion(before.version, expectedVersion);

  const after = await tx.lead.update({
    where: { id, tenantId: ctx.tid, version: expectedVersion },
    data: { ...patch, version: { increment: 1 }, modify_at: new Date() }
  });

  await tx.auditEvent.create({ ...auditRow('lead.updated', { before, after, patch }) });
  return after;
});

publishAfterCommit('vici2.lead.updated', { id, tenantId: ctx.tid });
```

If the update returns `Prisma.PrismaClientKnownRequestError` with
`P2025` (record-not-found), we map to `412 stale_version`.

### 3.3 Conflict response

```
HTTP/1.1 412 Precondition Failed
Content-Type: application/json

{ "error": "stale_version", "expected": 5, "actual": 3,
  "message": "Lead modified by another writer; re-fetch and retry." }
```

### 3.4 Status-update exception

Per RESEARCH §6.5 + D01.md risks: `POST /api/leads/:id/status` (D04
territory) is **last-write-wins** by design (one agent owns the
call). Audit captures prior state for recoverability. D01 PATCH
handler **rejects** any patch that includes a `status` field with
`400 STATUS_VIA_DEDICATED_ENDPOINT`; clients use D04's status route.

---

## 4. Bulk endpoint (FROZEN)

### 4.1 Request shape

```json
POST /api/leads/bulk
Idempotency-Key: <uuid>
Authorization: Bearer ...

{
  "list_id": 101,
  "leads": [ { "phone_e164": "+15551234567", "first_name": "Alice", ... } ],
  "options": {
    "skipDuplicates": true,    // default true → uses createMany skipDuplicates
    "dryRun": false,           // default false → validate-only when true
    "strict": false            // default false → 207 partial; true → all-or-nothing rollback
  }
}
```

### 4.2 Sizing

- Per-call cap **500 rows** (`400 TOO_MANY_ROWS` over).
- Body size limit raised to **4 MB** for this route only via
  Fastify route options (default 1 MB is too small for 500 fat rows
  with `custom_data`).
- D02 chunks 10 000-row CSVs into 20 calls of ≤ 500.

### 4.3 Semantics

1. **Per-row validation runs first** (Zod). Invalid rows go to
   `errors[]` with stable `code` strings (`INVALID_PHONE`,
   `MISSING_REQUIRED_FIELD`, `CUSTOM_DATA_SCHEMA_FAIL`,
   `INVALID_STATE`).
2. **Valid rows go to `prisma.lead.createMany({ skipDuplicates })`**
   inside a single `$transaction` together with the bulk audit row.
3. **`skipDuplicates: true`** ⇒ MySQL `INSERT ... ON DUPLICATE KEY
   IGNORE` for `UNIQUE(list_id, phone_e164)` collisions; counted to
   `skipped`.
4. **`strict: true`** ⇒ if `errors.length > 0` OR
   `skipped > 0`, the entire transaction rolls back; response is
   `400` with `{error:"strict_failure", errors, skipped}`. Used by
   N01 transactional CRM sync.
5. **`dryRun: true`** ⇒ validation runs; DB call is skipped;
   response shows what *would* have inserted. Audit row not written.
6. **Order preserved:** `errors[].row` is the 0-based index into the
   request `leads[]` so D02 maps back to source CSV line numbers.
7. **One audit row per bulk call** (`lead.bulk_inserted`,
   details_json `{list_id, count_inserted, count_skipped}`) — keeps
   audit volume sane. Per-row creation is *not* audited individually.

### 4.4 Speed budget

Target p95 < **1.5 s** for a 500-row bulk on Phase-1 hardware. If
production EXPLAIN/profiling shows a single 500-row chunk exceeding
this, fall back to raw `INSERT ... VALUES (...)` (Prisma issue #23791
[16] — ~5× faster) — implementation switch documented in HANDOFF.

---

## 5. Custom-fields strategy (FROZEN)

### 5.1 Storage

- `leads.custom_data JSON NOT NULL DEFAULT (JSON_OBJECT())` (per F02
  PLAN §4.13).
- Per-list schema validation: `lists.custom_field_schema JSON` →
  compiled to a Zod schema cached in an LRU (size 256, TTL 5 min,
  invalidated on `list.updated` event).

### 5.2 Read shape

- `GET /api/leads/:id` returns `custom_data` always.
- `GET /api/leads` returns `custom_data` **only if** `?include=custom_data`
  is passed OR a `?custom.<key>=` filter is in the query (the filter
  implies the client wants the data).

### 5.3 Write shape

- `POST` accepts the full `custom_data` object; validated against
  per-list Zod schema before insert.
- `PATCH` accepts a partial `custom_data` patch; server **deep-merges**
  with existing (`{...existing, ...patch.custom_data}`) and
  re-validates against per-list schema. Avoids the "PATCH wipes
  other keys" foot-gun.

### 5.4 Filter shape

`?custom.<key>=<value>` compiles to:
```sql
JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$."<key>"')) = ?
```
Phase-1 unindexed; tolerated when paired with an indexed filter
(`list_id`/`status`).

### 5.5 Index promotion endpoint

```
POST /api/lead-fields/:k/index
Authorization: Bearer <super_admin token>
```

Runs raw SQL via `prisma.$executeRawUnsafe` (no Prisma model for
generated columns; per RESEARCH §5.6 / Prisma issue #20663):

```sql
ALTER TABLE leads
  ADD COLUMN cf_<k> VARCHAR(255) AS
    (JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$."<k>"'))) VIRTUAL,
  ADD INDEX idx_t_cf_<k> (tenant_id, cf_<k>);
```

- `:k` validated against `^[a-z_][a-z0-9_]{0,30}$` (no SQL injection
  surface).
- DDL is **online for VIRTUAL columns** (no row rewrite per MySQL
  9.7 docs [7][8]).
- Records the promotion in a new `lead_field_indexes` config table
  (F02 amendment, Phase-2 nice-to-have; for Phase 1 we just rely on
  `INFORMATION_SCHEMA.COLUMNS` lookup).
- After promotion, the optimizer auto-rewrites
  `JSON_EXTRACT(custom_data,'$."k"')` predicates to use the gen-col
  index — no client query change needed.

### 5.6 Phase-2 escape hatch

If a tenant pushes past ~50 promoted fields, migrate to a per-tenant
`lead_custom_fields` table (column-per-key) — documented in HANDOFF;
no Phase-1 implementation work.

---

## 6. Phone normalization (FROZEN)

### 6.1 Library

- **`libphonenumber-js/min`** (80 KB bundle) per RESEARCH §7. Pinned
  `^1.11.x`.
- Stricter `/max` build (145 KB) considered; `/min` chosen — surfaces
  validity warnings (not errors) on bulk so legacy CRM imports
  don't fail wholesale.

### 6.2 Pipeline

```
function normalize(raw: string, defaultCountry: string): { e164: string; valid: boolean } {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
  if (!parsed) throw new InvalidPhone(raw);
  return { e164: parsed.number, valid: parsed.isValid() };
}
```

Applied at write time on `phone_e164`, `phone_alt`, `phone_alt2`
(per F02 schema). Default country = `lists.country_code` for the
target list (US default).

### 6.3 Acceptance

- `phone_e164`: must parse AND `isValid()` ⇒ otherwise reject
  `400 INVALID_PHONE`.
- `phone_alt`, `phone_alt2`: must parse; validity warning recorded
  to `errors[]` on bulk but still inserted.
- All stored E.164 strings start with `+` and contain digits only.

---

## 7. Multi-tenant scoping (FROZEN — delegated to F05)

### 7.1 Layer

D01 inherits the F05 Prisma Client Extension with AsyncLocalStorage
tenant context (F05 PLAN §8 + D01 RESEARCH §8). Every D01 query
auto-injects `where.tenantId = ctx.tenantId` for read/update/delete;
auto-injects `data.tenantId = ctx.tenantId` for create.

### 7.2 D01-specific rules

- D01 handlers **never** read `tenantId` from `req.params`,
  `req.query`, or `req.body`. The only source is `req.auth.tenantId`
  (set by F05 `requireAuth`).
- All Prisma calls live in `api/src/leads/**`. CI grep test fails
  any `prisma.lead.*` reference outside that directory tree (and a
  small allowlist for `api/src/system/**` migration scripts).
- Cross-tenant queries (none in Phase 1) require explicit
  `// TENANT-SCOPING-EXEMPT: <reason>` marker per F05 §6.3.

### 7.3 Tenant isolation tests

Integration tests (§14.2) attempt:
- Read another tenant's lead by ID → expects `404 NOT_FOUND`
  (intentionally not 403; don't leak existence).
- Bulk insert with a `tenant_id` field in the body → server ignores
  it; row inserted with the JWT's tenant.
- Custom-field promotion endpoint scoped per tenant (DDL is global,
  but the gen col is queried with `tenant_id` filter; index lead
  column is `(tenant_id, cf_<k>)`).

---

## 8. Rate limiting (FROZEN)

### 8.1 Plugin & store

- `@fastify/rate-limit` v9.x with the F04 Valkey-backed store.
- `keyGenerator(req)` → `${req.auth.tid}:${req.routerPath}`.
- `groupId` distinguishes routes for shared limit pools.

### 8.2 Per-route caps (Phase 1)

| Route | Cap (per tenant) |
|---|---|
| `GET /api/leads/lookup` | **600 rpm** (agent hot path) |
| `GET /api/leads` (list) | **60 rpm** |
| `GET /api/leads/:id` | **600 rpm** |
| `GET /api/leads/:id/calls` | **120 rpm** |
| `POST /api/leads` | **120 rpm** |
| `POST /api/leads/bulk` | **10 rpm** |
| `PATCH /api/leads/:id` | **120 rpm** |
| `DELETE /api/leads/:id` | **30 rpm** |
| `GET /api/leads?withCount=true` | **10 rpm** |
| `GET /api/leads/export` | **5 rpm** |
| `POST /api/lead-fields/:k/index` | **2 rpm** (DDL is heavy) |

429 response shape per F01 conventions:
`{ error: { code: "RATE_LIMIT", message, details: { retry_after_seconds } } }`.

---

## 9. Audit log integration (FROZEN)

### 9.1 Writer

D01 calls F05's shared `audit()` writer (F05 PLAN §9.1) — same
transaction as the entity mutation. F05 owns the table grant and
schema; D01 owns the action catalog below.

### 9.2 D01 action catalog

| Action | Trigger | `details_json` content |
|---|---|---|
| `lead.created` | POST /api/leads | inserted columns minus PII-bulk; `phone_e164` and `email` allowed (audit needs them) |
| `lead.updated` | PATCH /api/leads/:id | `{ before: <changed_keys>, after: <changed_keys> }` diff |
| `lead.deleted` | DELETE /api/leads/:id | `{ soft: true, deleted_at }` |
| `lead.bulk_inserted` | POST /api/leads/bulk | `{ list_id, count_inserted, count_skipped, error_count }` (one row per call, NOT per lead) |
| `lead.field_indexed` | POST /api/lead-fields/:k/index | `{ key, ddl }` |
| `lead.exported` | GET /api/leads/export | `{ filter_query_sha1, row_count }` (D02 enriches) |

D04 owns `lead.status_changed`; D06 owns `lead.recycled`; C04 owns
hard-delete sweep audit. Names live in
`shared/events/lead-events.json` (JSON Schema; D01 ships them).

### 9.3 Event publish (after commit)

After a successful commit, D01 publishes to Valkey Stream
`events:vici2.lead.{action}` with payload
`{ tenant_id, lead_id, actor_user_id, ts, action, details_json_hash }`.

- **At-least-once** semantics; downstream consumers (E01 hopper
  invalidator, M03 UI websocket pusher, list-cache invalidator) use
  consumer groups + `XACK`.
- The `audit_events` row is the **durable record**; the stream is
  best-effort. RESEARCH §9.3 documents the upgrade path to a true
  outbox table (deferred to O02-or-later).

### 9.4 No-secrets rule

- `details_json` may contain `phone_e164` and `email` (audit needs
  them).
- Pino log lines must NOT include `details_json` content. F05 §9.3
  CI grep already enforces; D01 adds `phone_e164` and `email`-in-
  stringified-payload patterns to the blocklist.

---

## 10. Performance targets (FROZEN; CI-enforced)

### 10.1 Targets (p95 under nominal load = 50 RPS read, 5 RPS write)

| Endpoint | p95 target | Hard ceiling | How |
|---|---|---|---|
| `GET /api/leads/:id` | **50 ms** | 100 ms | PK lookup, Prisma `select`, no `include` |
| `GET /api/leads` (50 rows, 1 filter) | **200 ms** | 500 ms | covered index + cursor WHERE + limit 51 |
| `GET /api/leads/lookup` | **30 ms** | 100 ms | `idx_t_phone` lookup, LIMIT 5 |
| `POST /api/leads` | **80 ms** | 200 ms | normalize + zod + insert + audit (1 tx) |
| `PATCH /api/leads/:id` | **100 ms** | 250 ms | version-CAS update + audit |
| `POST /api/leads/bulk` (500 rows) | **1.5 s** | 5 s | createMany + 1 audit row |
| `DELETE /api/leads/:id` | **80 ms** | 200 ms | UPDATE deleted_at + audit |
| `GET /api/leads/:id/calls` | **150 ms** | 500 ms | covered join `(lead_id, ts)` |

### 10.2 Tactics

1. **Prisma `select` everywhere on list endpoints.** Never `include`
   by default.
2. **Verify with `prisma:query` log inspection** during VERIFY phase
   (D01.md acceptance criterion).
3. **Default-omit `custom_data` from list responses** — wide JSON
   columns blow up payload size 2–10×.
4. **Compression** via `@fastify/compress` for list endpoints.
5. **Connection pool** — Prisma default 10; raise to `num_cpus*2 +
   1` (9 on a 4-vCPU box) per Prisma docs.
6. **Body size limit** raised to **4 MB** for `/api/leads/bulk` only
   (default 1 MB too small).
7. **Read-heavy cache** — `GET /api/leads` only:
   - Key: `t:{tid}:leads:list:{sha1(canon_query)}`
   - Value: serialized response
   - TTL: 30 s
   - Invalidator: subscribes to Valkey Stream `events:vici2.lead.*`,
     flushes prefix `t:{tid}:leads:list:*` (Valkey SCAN+UNLINK).
   - **Lookup-by-phone is NOT cached** (correctness > latency).
8. **Index hint annotations** — query shapes match F02 indexes;
   `EXPLAIN` validated in IMPL.

### 10.3 Load-test plan (executed in O03)

- k6 scripts under `scripts/load-test/leads-*.js`.
- Scenarios: read-list, single-create, bulk-500, lookup-burst, mixed.
- Pass criteria: §10.1 p95 hits under 100 RPS aggregate, 0 errors.

---

## 11. Code structure (FROZEN file list)

### 11.1 TypeScript (api)

```
api/src/leads/
  handlers/
    list.ts                     — GET /api/leads
    lookup.ts                   — GET /api/leads/lookup
    get.ts                      — GET /api/leads/:id
    create.ts                   — POST /api/leads
    bulk.ts                     — POST /api/leads/bulk
    update.ts                   — PATCH /api/leads/:id
    delete.ts                   — DELETE /api/leads/:id
    calls.ts                    — GET /api/leads/:id/calls
    export.ts                   — GET /api/leads/export (streaming)
    promote-field.ts            — POST /api/lead-fields/:k/index
  schemas.ts                    — Zod schemas (input + response shapes), exported
  cursor.ts                     — encode/decode + validation
  cache.ts                      — Valkey cache wrapper for list endpoint
  permissions.ts                — RBAC scope checks (own-vs-all helpers)
  normalize.ts                  — libphonenumber-js wrapper
  audit.ts                      — wraps F05 audit() with D01 action catalog + diff helpers
  validation.ts                 — per-list Zod schema cache (custom_data)
  events.ts                     — after-commit publishAfterCommit('vici2.lead.*')
  index.ts                      — Fastify plugin: route registration + global rate-limit config

api/src/leads/sql/
  promote-field.sql.ts          — DDL templates for gen-col promotion
  count-capped.sql.ts           — capped-COUNT(*) helper

shared/types/src/
  lead.ts                       — public Lead schema (Zod) + types (re-exported via @vici2/types)
  lead-events.ts                — event payload types

shared/events/
  lead-events.json              — JSON Schema for vici2.lead.* stream payloads

shared/openapi/
  openapi.yaml                  — D01 contributes /leads/* paths + Lead schemas

api/test/leads/
  schemas.test.ts               — zod round-trip + edge cases
  cursor.test.ts                — encode/decode/tampering
  normalize.test.ts             — libphonenumber edge cases
  cache.test.ts                 — TTL + invalidation
  permissions.test.ts           — own-vs-admin scope
  handlers/
    list.test.ts                — pagination + filter combos
    lookup.test.ts              — phone E.164 + dedupe
    get.test.ts                 — 404 vs 403 (tenant isolation)
    create.test.ts              — validation + dup detection
    bulk.test.ts                — partial / strict / dryRun + idempotency
    update.test.ts              — version CAS happy + 412 + status-rejection
    delete.test.ts              — soft + idempotent
    calls.test.ts               — join projection
    promote-field.test.ts       — DDL only on super_admin; key validation
  integration/
    tenant-isolation.test.ts    — cross-tenant access ⇒ 404
    rate-limit.test.ts          — Valkey-store enforcement
    audit-trail.test.ts         — every mutation writes audit row
    event-publish.test.ts       — after-commit stream payload shape
  perf/
    list-p95.k6.js              — 50-row list under 200 ms p95
    lookup-p95.k6.js            — phone lookup under 30 ms p95
    bulk-throughput.k6.js       — 500-row bulk under 1.5 s
```

### 11.2 Shared (cross-package)

- `@vici2/types` exports `Lead`, `LeadCreate`, `LeadPatch`,
  `LeadListQuery`, `LeadListResponse`, `LeadBulkRequest`,
  `LeadBulkResponse`, `LeadCursor` from `shared/types/src/lead.ts`.
- `web/` and `workers/` import from `@vici2/types` for compile-time
  type safety.
- `shared/openapi/openapi.yaml` is regenerated on `make
  gen-openapi`; CI fails on uncommitted diff.

---

## 12. OpenAPI integration

- Routes registered via `fastify-zod-openapi` (RESEARCH cite [36]).
- Build step `make gen-openapi`:
  1. Boots Fastify in dry-mode.
  2. Reads `fastify.swagger()` JSON.
  3. Merges D01's `/leads/*` slice into
     `shared/openapi/openapi.yaml` (preserving other modules' slices).
  4. Runs `openapi-typescript shared/openapi/openapi.yaml -o
     packages/api-client/src/generated.ts`.
  5. CI fails on uncommitted diff in either file.
- D01 owns these path keys: `/leads`, `/leads/lookup`, `/leads/{id}`,
  `/leads/{id}/calls`, `/leads/export`, `/leads/bulk`,
  `/lead-fields/{k}/index`.
- D01 contributes these `components.schemas`: `Lead`, `LeadCreate`,
  `LeadPatch`, `LeadListResponse`, `LeadBulkRequest`,
  `LeadBulkResponse`, `LeadCursor`, `LeadError`.

---

## 13. F02 amendment requests (orchestrator will batch)

### 13.1 Add `version` column to `leads`

```sql
ALTER TABLE leads
  ADD COLUMN version SMALLINT NOT NULL DEFAULT 1
  AFTER modify_at;
```

Prisma schema:
```prisma
model Lead {
  // ... existing fields ...
  version  Int  @default(1) @db.SmallInt
}
```

- Type: SMALLINT (2 bytes; max 32 767 — wraps after ~32 k edits per
  lead, survives years; if hit, action is to migrate to INT, not a
  business problem).
- No data backfill needed (default 1).
- Migration is **online** (ADD COLUMN with DEFAULT in MySQL 8 is
  instant for InnoDB; no row rewrite).
- Rollback (per F02 reversibility rule):
  ```sql
  ALTER TABLE leads DROP COLUMN version;
  ```

### 13.2 (No other F02 amendments from D01)

`lead_field_indexes` config table is deferred to Phase 2; for Phase
1 we read promoted columns from `INFORMATION_SCHEMA.COLUMNS` at
endpoint time.

---

## 14. Hand-off interfaces (frozen)

### 14.1 To D02 (CSV import worker)

- D02 chunks 10 000-row CSV into ≤ 20 calls of `POST /api/leads/bulk`
  with `Idempotency-Key` set per chunk.
- D02 maps `errors[].row` → CSV line numbers via its own offset
  bookkeeping.
- D02 sets `options.skipDuplicates=true` for idempotent re-imports;
  toggles `options.strict=true` for transactional CRM sync (N01).

### 14.2 To D04 (statuses)

- D04 owns `POST /api/leads/:id/status` and `bulk-status`.
- D04 reads `statuses` table for transition validation; D01 PATCH
  rejects `status` field in body to prevent shadow status writes.
- D04 calls D01's audit/event helpers for `lead.status_changed` to
  keep the stream contract consistent.

### 14.3 To D05 (DNC)

- D01 does **not** scrub on lead creation (E01 hopper filler runs
  the dial-time scrub).
- D01 `GET /api/leads/:id` returns a `dnc_status` hint
  (`{checked_at, federal, state, internal}`) for UI display, populated
  via cached lookup against D05's tables. **Read-only hint;
  authoritative scrub is at dial time.**

### 14.4 To D06 (callbacks)

- D06 owns the `POST /api/leads/:id/recycle` endpoint and the
  callback table. D01 doesn't manage callback state.
- D06 may PATCH leads via the standard endpoint to update e.g.
  `last_called_at`, `called_count`; subject to optimistic locking.

### 14.5 To C01 (timezone gate)

- D01 surfaces `lead.known_timezone`, `lead.zip`, `lead.state` in
  every read shape (selected by default; small columns).
- C01 reads these via direct DB query in the hopper-filler hot path
  (not via D01 API; perf).

### 14.6 To E01 (hopper filler)

- E01 queries leads via direct Prisma access (using the same Prisma
  client + tenant extension); does NOT go through D01's REST API
  for perf.
- E01 subscribes to `events:vici2.lead.*` to invalidate hopper
  entries on `lead.updated`/`lead.deleted` events.

### 14.7 To M03 (admin lead UI)

- M03 consumes the D01 REST API exclusively; uses TanStack Table for
  list views with cursor pagination.
- M03 imports types from `@vici2/types` (no manual type duplication).
- M03 wires `If-Match`/`ETag` headers via an Axios interceptor for
  edit forms.

### 14.8 To A05 (live call panel)

- A05 calls `GET /api/leads/:id` on call-screen-pop; uses the
  returned `version` to PATCH on dispo save.
- A05 calls `GET /api/leads/lookup?phone_e164=` on inbound
  customer-ID lookup (RBAC: own-call-only).

### 14.9 To N01 (external API, Phase 4)

- N01 wraps `POST /api/leads` and `POST /api/leads/bulk` with its
  own integrator authentication; passes through `Idempotency-Key`.
- N01 enforces `options.strict=true` for transactional CRM sync.

### 14.10 To O01 (observability)

Prom metrics emitted by D01 module (per F01 metric naming):

- `vici2_api_leads_request_total{route,method,status}`
- `vici2_api_leads_request_duration_seconds{route,method}` (histogram)
- `vici2_api_leads_bulk_inserted_total{outcome="inserted|skipped|error"}`
- `vici2_api_leads_cache_hits_total{endpoint="list"}`
- `vici2_api_leads_optimistic_lock_conflict_total`
- `vici2_api_leads_phone_normalize_failure_total`
- `vici2_api_leads_event_publish_total{action,outcome}`
- `vici2_api_leads_field_promoted_total{tenant_id}`

---

## 15. Open questions resolved (10 from RESEARCH §11)

| # | Question | Resolution |
|---|---|---|
| 1 | Status enum source-of-truth | **D04 owns.** D01 PATCH rejects `status` field; clients use D04's status endpoint. |
| 2 | Recycle semantics (called_count reset?) | **D06 owns.** D01 ships only the standard PATCH; D06 designs the recycle endpoint and column semantics. |
| 3 | Idempotency-Key TTL | **24 h** (Stripe parity; Valkey memory budget acceptable per F04 PLAN). |
| 4 | Bulk strict mode | **Opt-in via `options.strict` body flag** (default false, partial-success). All-or-nothing rollback when true. |
| 5 | If-Match strictness | **Accept both strong (`"5"`) and weak (`W/"5"`)** on parse; treat as strong (we never serve weak). |
| 6 | Cursor stability on sort change | **Reject with `400 CURSOR_SORT_MISMATCH`**; client restarts pagination. |
| 7 | Custom-field promotion authorization | **`super_admin` only** (DDL is heavy and forever-cost). |
| 8 | Search scope (add phone?) | **Don't add phone to `?search=`**; clients use `/lookup` for phones. |
| 9 | Soft-delete sweep ownership | **C04 (retention worker)** runs hard-delete on rows older than configured window (TCPA / GDPR aware). D01 just sets `deleted_at`. |
| 10 | OpenAPI slice ownership | **D01 owns `/leads/*` and `/lead-fields/*`** plus the `Lead*` schemas. Other modules contribute their own slices and reuse `Lead` via `$ref`. |

---

## 16. Tests

### 16.1 Unit (vitest)

- Zod schemas: input validation edges (E.164 boundaries, custom_data
  shape, cursor `v` mismatch).
- Cursor encode/decode round-trip; tamper rejection.
- Phone normalization: empty input, country defaulting, alt phones.
- Audit-row diff helpers.
- Permission helpers (own-vs-admin).

### 16.2 Integration (vitest + testcontainers)

- Real MySQL 8 + Valkey via docker-compose (F01 stack).
- Login → list → get → patch → delete cycle.
- Bulk insert 500 rows; partial-success path; strict-failure path;
  dryRun path; idempotency replay.
- Optimistic-lock conflict path (concurrent PATCH).
- Tenant isolation (cross-tenant access ⇒ 404).
- Custom-field filter w/ + w/o promotion (EXPLAIN-asserts index use
  after promotion).
- Audit trail completeness (every mutation has matching `audit_events`
  row).
- Event publish (after-commit stream payload shape + content).
- N+1 detection: list endpoint with 50 rows triggers exactly 1
  Prisma query (asserted via Prisma `query` event log).

### 16.3 Performance (k6, run in O03)

- Read latency: 100 RPS sustained, p95 < 50 ms (single), 200 ms (list).
- Lookup burst: 600 rpm, p95 < 30 ms.
- Bulk throughput: 500-row chunks, p95 < 1.5 s.
- Mixed workload: 80 % reads / 20 % writes, no error budget breach.

### 16.4 Security

- Tenant boundary breach attempts (forge `tenantId` in body) → ignored.
- SQL-injection probe on `?custom.<key>=` and `:k` field promotion
  (Zod `^[a-z_][a-z0-9_]{0,30}$` regex blocks).
- Permission breach: agent attempts admin endpoints → 403.
- Phone-number disclosure: log lines never contain bulk phone arrays
  (CI grep).

### 16.5 Coverage target

- **≥ 70 %** on `api/src/leads/**` per SPEC §3.10 baseline.
- **≥ 90 %** on the optimistic-lock + audit + tenant-injection paths
  (compliance-relevant).

### 16.6 Run commands

```
make test-leads                 # unit + integration in api package
cd api && pnpm exec vitest run test/leads
make perf-leads                 # k6 scenarios (O03 entrypoint)
```

---

## 17. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Custom-data schema migrations break old leads | Medium | Medium | Validation lenient on read; strict on write (per D01.md risks). |
| Concurrent status updates lose data | Low | Low | Last-write-wins by design (D04 owns); audit captures prior state for recovery. |
| `createMany` perf regression on 500-row chunks | Low | Medium | Raw `INSERT VALUES` fallback documented (Prisma issue #23791); CI perf test gates. |
| Custom-field promotion DDL blocking | Low | Medium | VIRTUAL columns are online; super_admin-only; rate-limited 2 rpm. |
| Cache stampede on list endpoint | Low | Low | 30-s TTL; single-flight via Valkey `SET NX` lock per cache key. |
| Tenant-bypass via missing extension on a new query | Medium | High | CI grep blocks raw `prisma.lead.*` outside `api/src/leads/`; integration test attempts cross-tenant read. |
| Event stream consumer lag → stale list cache | Low | Low | 30-s TTL bounds staleness; `lead.updated` invalidation publish is best-effort but cache is best-effort too. |
| F02 `version` column amendment delayed | Low | High | F02 is pre-IMPLEMENT; amendment is one ALTER + Prisma field; coordinated at orchestrator level. |

---

## 18. RFCs filed

**Zero RFCs filed by this PLAN.** All decisions derive from the
RESEARCH (36 citations) and from upstream PLANs (F01–F05). Notable
explicit deferrals (each properly handed off, not punted):

- D04 owns status update + transition validation.
- D06 owns recycle + callback semantics.
- C04 owns soft-delete sweep.
- N01 (Phase 4) owns external add_lead authentication.
- E01 (Phase 2) reads leads via direct DB, not via D01 API.

---

## 19. Acceptance criteria (from D01.md, restated against this PLAN)

- [ ] All endpoints implemented + RBAC enforced (§1, §11).
- [ ] **Phone normalization to E.164 at write time** (§6).
- [ ] **Bulk insert ≥ 10 k rows in ≤ 30 s** via D02 chunking (§4.4).
- [ ] **Custom-data validated per-list schema** with deep-merge on
      PATCH (§5).
- [ ] **Events emitted after commit** (§9.3).
- [ ] **Pagination ≤ 200 rows / page**, default 50 (§2.4).
- [ ] **Soft-delete preserves history**; idempotent (§1.3).
- [ ] **No N+1 queries in list endpoint** (verified by Prisma query
      log inspection; integration test §16.2).
- [ ] OpenAPI slice generated and committed (§12).
- [ ] Tenant isolation verified (cross-tenant access ⇒ 404; §16.4).
- [ ] Optimistic-lock CAS with 412 response (§3).
- [ ] F02 amendment merged: `leads.version SMALLINT NOT NULL
      DEFAULT 1` (§13.1).
- [ ] Performance targets met under k6 (§10, §16.3).
- [ ] HANDOFF.md ships with downstream consumer guide + raw-INSERT
      fallback runbook + Phase-2 escape hatches.

---

End of PLAN.md.
