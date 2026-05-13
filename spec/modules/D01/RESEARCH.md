# D01 — Lead CRUD Service — RESEARCH

**Module:** D01
**Phase:** RESEARCH (PLAN blocked on F05 PLAN — RBAC permission verbs and middleware shape must freeze first)
**Date:** 2026-05-06
**Status:** Research only — no code, no PLAN.

D01 owns the REST + service-layer CRUD for `leads`. It is the foundation
of every read/write path that touches a lead row: admin UI list views,
agent quick-lookup, dialer hopper-filler reads (E01), CSV import (D02),
manual-dial creates (A04), disposition writes (A06), callback re-adds
(D06), external CRM sync (N01). Every other module in the data tier
either calls D01 or reads tables D01 writes to.

The leads table is already defined in DESIGN.md §4.13 and refined in
F02 PLAN §4.13 (custom_data JSON, soft-delete via `deleted_at`, the
nine `idx_t_*` indexes, the `(tenant_id, list_id, status, modify_at)`
hopper-key composite). RESEARCH here is about the API surface, not the
schema.

---

## 1. Executive summary (10 bullets)

1. **Cursor-based (keyset) pagination is the default** for `GET /api/leads`,
   with the cursor encoding `(modify_at, id)` for the hopper-aligned scan
   and `(created_at, id)` as the alternate sort. Offset is allowed only
   for `?sort=rank` admin views capped at `offset ≤ 10_000`. Every list
   endpoint returns `{data, page:{next_cursor, has_more, limit}}` —
   never a `total` count by default. Industry consensus (Zalando, Stripe,
   GitHub, Slack, Relay Connections) is unanimous: total counts on large
   tables are `COUNT(*)` traps. [1][2][3][4][6]
2. **Cursor format = `base64url(JSON({v:1, k:[modify_at_iso, id]}))`**,
   opaque to clients, validated server-side against the requested sort.
   Tampering yields `400 invalid_cursor`. Cursor is replay-safe across
   inserts/deletes because keyset uses `WHERE (modify_at, id) < (?, ?)`
   — new rows can never duplicate or skip already-paged rows. [4][6]
3. **Write endpoints use optimistic locking via a `version SMALLINT`
   column** (the recommended pattern; ETags are equivalent at the wire
   level but version columns are simpler in MySQL). On `PATCH /api/leads/:id`
   the client sends `If-Match: <version>` (or `version` in the body for
   non-browser clients). Server runs `UPDATE leads SET ... ,
   version = version + 1, modify_at = NOW(6) WHERE id = ? AND tenant_id = ?
   AND version = ?` — affected-rows == 0 ⇒ `409 stale_version`, client
   re-fetches. **`updated_at`/`If-Unmodified-Since` is rejected** for the
   write path because MySQL `DATETIME(6)` precision plus clock skew is
   not strong enough under high-frequency dispo writes (we have agents
   doing 60+ status changes per hour). [11][12][13][26]
4. **Status updates bypass optimistic locking by design.** `POST /api/leads/:id/status`
   is intentionally last-write-wins per the D01 spec risk note — agents
   dispositioning the same lead is rare (one agent owns the call), and
   serializing status would block hopper recycling. Audit log captures
   prior state so any "lost" status is recoverable. [D01.md §risks]
5. **Bulk endpoint = `POST /api/leads/bulk` with chunk size 500 per call,
   `skipDuplicates: true` (Prisma `createMany`), partial-success semantics**:
   response = `{inserted, skipped, errors:[{row, code, message}]}`. The
   500-row chunk size is below Prisma's MySQL safe-batch threshold and
   well under our `max_allowed_packet` budget. Larger inputs (D02 CSV)
   chunk at the caller (D02). createMany under MySQL writes
   `INSERT ... ON DUPLICATE KEY IGNORE` with `skipDuplicates`, so inserts
   never partially fail mid-batch. [14][15][16]
6. **Custom fields query strategy = JSON column with on-demand virtual
   generated columns + index, added per-tenant when filter pressure
   demands it.** Phase 1 stays JSON-only; D01 surfaces a
   `?custom.<key>=<value>` filter that compiles to
   `JSON_UNQUOTE(JSON_EXTRACT(custom_data,'$."<key>"')) = ?`. We do not
   create generated columns by default (write-amplification cost on every
   lead write); we expose an admin endpoint `POST /api/lead-fields/:key/index`
   that creates a virtual generated column + B-tree index online. Tracks
   the F02 escape-hatch decision, lets us start without per-tenant DDL.
   Prisma cannot model the generated columns natively — managed by a
   raw SQL migration template. [7][8][9][10]
7. **libphonenumber-js `/min` build (80 KB) is enough for E.164
   normalization at write time.** All inbound phones (`phone_e164`,
   `phone_alt`, `phone_alt2`) pass through `parsePhoneNumberFromString(raw,
   country_code).number`. We accept either formatted or raw digits;
   reject anything that fails `isValidNumber()`. Default `country_code`
   per-list (defaults to `US` per the leads schema). The `/max` build
   adds 65 KB and stricter validity checks; we choose `/min` for the API
   process and surface validity warnings (not errors) so legacy CRM
   imports don't fail wholesale. [17][18]
8. **Multi-tenant scoping = Prisma Client Extension (`$extends`) with
   AsyncLocalStorage tenant context.** Every query auto-injects
   `where: { tenantId: ctx.tenantId }`; create/update auto-injects
   `data: { tenantId: ctx.tenantId }`. Bypass requires explicit
   `skipTenantCheck: true` flag (used only by F02 migrations and the
   compliance auditor). CI grep blocks raw `prisma.leads.findMany`
   without the extension. F02 PLAN §181 already declares
   `tenantId BigInt @default(1) @map("tenant_id")` everywhere — we
   build on that. The middleware approach in older Prisma docs is
   deprecated; `$extends` is the supported path for Prisma 6+. [19][20][21][22]
9. **Rate limiting via `@fastify/rate-limit` keyed on `(tenant_id, route)`,
   Redis-backed**, with per-route caps documented in OpenAPI:
   - `GET /api/leads` (list) — 60 req/min/tenant
   - `GET /api/leads/lookup` (agent hot path) — 600 req/min/tenant
   - `POST /api/leads/bulk` — 10 req/min/tenant
   - `POST /api/leads` (single create) — 120 req/min/tenant
   `keyGenerator` reads `req.auth.tid` (set by F05 auth middleware).
   `groupId` distinguishes routes. [23][24]
10. **Performance targets — single read p95 < 50 ms (target 100 ms),
    paginated list 50 leads p95 < 200 ms (target 500 ms), bulk insert
    10k rows < 30 s.** Hit them by: (a) covered indexes on every list
    filter combo (already in F02), (b) Prisma `select` instead of
    `include` everywhere — no relation loading on list endpoints unless
    requested via `?expand=list,owner`, (c) `JSON_OBJECT()` projection
    of `custom_data` only when `?include=custom_data` is set
    (custom_data can be ≤ 8 KB per row), (d) Redis cache on
    `GET /api/leads` *only* with cache-key
    `t:{tid}:leads:list:{sha1(query)}` and 30-s TTL invalidated by any
    `lead.*` event. Lookup-by-phone has no cache (correctness > latency).

---

## 2. REST API surface

**Base path:** `/api/leads` (mounted under `api/src/routes/leads/` per
F01 PLAN §2). All routes require a valid bearer JWT (F05); tenant scoping
is automatic via the Prisma extension; permissions are checked in
`preValidation` per the F05 RBAC matrix.

### 2.1 Endpoint table

| Method | Path | RBAC perm | Purpose | Response |
|---|---|---|---|---|
| `GET` | `/api/leads` | `lead:read` | list with filters + cursor pagination | `{data:Lead[], page}` |
| `GET` | `/api/leads/:id` | `lead:read` (own if agent) | single lead with optional includes | `Lead` + `ETag` header |
| `GET` | `/api/leads/lookup` | `lead:read` (own if agent) | by phone E.164 (most-recent first) | `{matches:Lead[]}` |
| `POST` | `/api/leads` | `lead:create` | create one | `Lead` (201) + `Location` |
| `POST` | `/api/leads/bulk` | `lead:import` | create up to 500 | `{inserted, skipped, errors}` |
| `PATCH` | `/api/leads/:id` | `lead:edit` | update non-status fields (optimistic-locked) | `Lead` |
| `POST` | `/api/leads/:id/status` | `lead:edit` (own if agent) | change status — emits event | `Lead` |
| `POST` | `/api/leads/bulk-status` | `lead:edit` | `{ids[], status, comment}` (≤200 ids) | `{updated, errors}` |
| `POST` | `/api/leads/:id/recycle` | `lead:edit` (D06 internal) | re-add to dialable (resets `called_count`?) | `Lead` |
| `DELETE` | `/api/leads/:id` | `lead:delete` | soft-delete (`deleted_at = NOW(6)`) | `204` |
| `POST` | `/api/leads/:id/restore` | `lead:delete` | undo soft-delete (admin only) | `Lead` |
| `GET` | `/api/leads/:id/history` | `lead:read` | call_log + agent_log + status changes | `{events[]}` |

### 2.2 Query parameters on `GET /api/leads`

| Param | Type | Notes |
|---|---|---|
| `list_id` | number \| number[] | scopes to one or many lists |
| `status` | string \| string[] | uppercase 8-char codes |
| `owner_user_id` | number | owner-dialing scope |
| `phone_e164` | string | exact match (use `/lookup` for variants) |
| `state` | string | 2-letter |
| `min_called`, `max_called` | int | `called_count` range |
| `created_after`, `created_before` | ISO8601 | range |
| `modified_after`, `modified_before` | ISO8601 | range |
| `search` | string | last-name / first-name / email / vendor_lead_code prefix; ≥3 chars |
| `custom.<key>` | string | JSON-extract equality filter |
| `include_deleted` | bool | admin-only; default false |
| `cursor` | opaque base64 | pagination cursor |
| `limit` | int | default 50, max 200 |
| `sort` | enum | `modify_at_desc` (default), `created_at_desc`, `rank_desc` |
| `expand` | csv | `list,owner,callbacks` (relation loading) |
| `include` | csv | `custom_data` (omitted by default if no filter touches it) |

### 2.3 Example payloads

**`POST /api/leads` request:**
```json
{
  "list_id": 101,
  "phone_e164": "+15551234567",
  "country_code": "US",
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane@example.com",
  "state": "CA",
  "postal_code": "94110",
  "rank": 0,
  "custom_data": { "campaign_source": "facebook_q2", "lead_score": 78 }
}
```

**`POST /api/leads` response (201):**
```json
{
  "id": 1742031,
  "tenant_id": 1,
  "list_id": 101,
  "status": "NEW",
  "phone_e164": "+15551234567",
  "tz_offset_min": -480,
  "known_timezone": "America/Los_Angeles",
  "version": 1,
  "entry_at": "2026-05-06T14:21:55.123456Z",
  "modify_at": "2026-05-06T14:21:55.123456Z",
  "...": "..."
}
```
Headers: `Location: /api/leads/1742031`, `ETag: "1"` (mirrors `version`).

**`GET /api/leads` response:**
```json
{
  "data": [ { "id": 1742031, "...": "..." }, { "id": 1742030, "...": "..." } ],
  "page": {
    "limit": 50,
    "has_more": true,
    "next_cursor": "eyJ2IjoxLCJrIjpbIjIwMjYtMDUtMDZUMTQ6MjE6NTUuMTIzNDU2WiIsMTc0MjAzMF19"
  }
}
```

**`POST /api/leads/bulk` request:**
```json
{
  "list_id": 101,
  "rows": [
    { "phone_e164": "+15551234567", "first_name": "Alice", "custom_data": {} },
    { "phone": "(555) 234-5678", "country": "US", "first_name": "Bob" }
  ]
}
```

**`POST /api/leads/bulk` response (207):**
```json
{
  "inserted": 1,
  "skipped": 0,
  "errors": [
    { "row": 1, "code": "INVALID_PHONE", "message": "phone failed E.164 validation" }
  ]
}
```

**`PATCH /api/leads/:id` request:**
```
PATCH /api/leads/1742031
If-Match: "3"

{ "email": "jane.new@example.com" }
```
Response 200 with new ETag `"4"`, or 412 `precondition_failed` if version stale.

### 2.4 Idempotency

- `POST /api/leads` accepts `Idempotency-Key: <uuid>` header (Stripe pattern). Server stores the response in Redis at `t:{tid}:idem:lead:{key}` for 24 h; replay returns cached body. Clients (CSV importer D02, N01 webhook) MUST send this for at-least-once delivery semantics.
- `POST /api/leads/bulk` similarly accepts `Idempotency-Key`; the saved response covers the entire `{inserted, skipped, errors}` payload.
- `PATCH` is naturally idempotent because of the version check (replay sees the same version twice → second wins or 412).
- `DELETE` is idempotent because second call finds `deleted_at IS NOT NULL` and returns 204 again.

---

## 3. Pagination strategy

### 3.1 Choice: keyset cursor

Three patterns considered:

| Pattern | Pros | Cons | Verdict |
|---|---|---|---|
| **Offset/limit** (`?page=`) | simple, random access | O(n) at depth, inconsistent under writes | **rejected** for default; allowed for `?sort=rank` admin only with hard cap |
| **Cursor (opaque)** | O(1) at any depth, write-stable, hides keys | no jump, no total | **CHOSEN** for default |
| **Keyset (visible)** | same as cursor + transparent | exposes internal columns | rejected — clients shouldn't depend on `(modify_at, id)` shape |

Citations: [1][2][3][4][6] — Zalando, Stripe, GitHub, Slack, Relay
all default to cursor for production list endpoints.

### 3.2 Cursor encoding

Cursor = base64url(`{v:1, k:[modify_at_iso, id]}`). Server-side decode
validates structure and `v`. Mismatched `v` ⇒ `400`. `k` length must
match the requested `sort`.

### 3.3 Query shape

For `sort=modify_at_desc` (default), the SQL becomes:

```sql
SELECT ... FROM leads
WHERE tenant_id = ?
  AND deleted_at IS NULL
  AND (modify_at, id) < (?, ?)            -- cursor key (when present)
  AND <other filters>
ORDER BY modify_at DESC, id DESC
LIMIT 51                                   -- limit + 1 to compute has_more
```

`(tenant_id, list_id, status, modify_at)` index covers the hot path
(`?list_id=&status=`) — verified against F02 PLAN §4.13 indexes.
Note: `id` tiebreaker is mandatory for determinism when `modify_at`
collides (sub-microsecond writes can repeat).

### 3.4 Limit defaults

- default 50, max 200, hard cap rejected with `400 invalid_limit`.
- `limit=0` rejected.
- D01.md acceptance criteria says "Pagination ≤ 200 rows / page" — honored.

### 3.5 Total counts

- omitted by default per industry consensus [1][2][4].
- `?include_count=true` runs a separate query gated to admin role and
  rate-limited (10 req/min/tenant). If `count > 100_000`, response
  returns `{count_estimate: 100000, count_capped: true}` (skip exact
  count to avoid table scan). Matches Stripe / GitHub behavior.

---

## 4. Search / filter capability matrix

| Capability | Mechanism | Index used | Notes |
|---|---|---|---|
| Filter by `list_id` | `WHERE tenant_id=? AND list_id=?` | `idx_t_list_status_modify` (prefix) | always paired with status in hopper queries |
| Filter by `status` | `WHERE tenant_id=? AND status=?` | `idx_t_status_modify` | uppercase 8-char codes |
| Combined `list_id+status` | composite | `idx_t_list_status_modify` | hot path; covers hopper-filler |
| Lookup by phone | `WHERE tenant_id=? AND phone_e164=?` | `idx_t_phone` | distinct endpoint `/lookup` |
| Filter by owner | `WHERE tenant_id=? AND owner_user_id=?` | `idx_t_owner_status` | owner-dialing |
| Filter by `state` | `WHERE tenant_id=? AND state=?` | `idx_t_state` | TCPA gating |
| Filter by `vendor_lead_code` | `WHERE tenant_id=? AND vendor_lead_code=?` | `idx_t_vendor` | external CRM lookups |
| Range on `modify_at` / `created_at` | `BETWEEN` | uses `(tenant_id, …, modify_at)` if list/status set | otherwise scan-with-filter |
| `called_count` range | `WHERE tenant_id=? AND called_count BETWEEN ? AND ?` | `idx_t_called_count` | recycle filters |
| `postal_code` | `WHERE tenant_id=? AND postal_code=?` | `idx_t_postal` | TZ resolver |
| `search` (last/first/email/vendor) prefix | `LIKE 'val%'` on each col, OR'd | none — small result set | requires `≥3 chars`, returns ≤ 100 |
| Custom-field equality | `JSON_UNQUOTE(JSON_EXTRACT(custom_data,'$.X'))=?` | none by default; virtual gen col on demand | Phase 1 unindexed; warned in OpenAPI |
| Full-text on `comments` / `name` | not implemented Phase 1 | — | InnoDB FTS [27] is slower than MyISAM and BOOLEAN-mode quirks; defer to ElasticSearch (R02) or a future `lead_search` module |

### 4.1 Why no full-text in Phase 1

- InnoDB FTS is committed-only (FTS index updates at COMMIT time) — our
  60+ updates/sec on `leads` would invalidate FTS rankings frequently.
  [27]
- BOOLEAN mode results don't match `LIKE '%kw%'` semantics that admins
  expect — confusion guaranteed. [28]
- The `search=` prefix endpoint covers the 95 % case (admin types
  "Smith" looking for a customer). Anything beyond is R02 (reporting /
  search-cluster scope).

### 4.2 Custom-field filters

Default behavior: unindexed JSON_EXTRACT. Acceptable for `custom_data`
filters scoped by an indexed `list_id` (small partition).

For tenants with high cardinality custom-data filters, the admin endpoint
`POST /api/lead-fields/:key/index` runs a migration:

```sql
ALTER TABLE leads
  ADD COLUMN cf_<key> VARCHAR(255) AS (JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$."<key>"'))) VIRTUAL,
  ADD INDEX idx_t_cf_<key> (tenant_id, cf_<key>);
```

This is online (no row-data rewrite for VIRTUAL); subsequent JSON-extract
queries auto-use the index per MySQL's optimizer rewrite. [7][8][9]
Tracked in HANDOFF as "promotion path — defer until needed."

---

## 5. Bulk endpoint design

### 5.1 Sizing

- Per-call cap: **500 rows**. Larger requests ⇒ `400 too_many_rows`.
- D02 (CSV import) chunks 10 000-row files into 20 calls of 500 each.
- Prisma `createMany` is `INSERT INTO ... VALUES (?,?…),(?,?…)…` — at
  500 rows × ~30 cols × ~30 chars per value ≈ 450 KB SQL string,
  comfortably under MySQL `max_allowed_packet` default (4 MB) and
  Prisma's `MAX_BIND_VALUES` (32 768 in MySQL driver; 500×30=15 000).
  [14][15]

### 5.2 Semantics: partial success

```
POST /api/leads/bulk
Body: { list_id, rows: [...] }

Response 207 Multi-Status:
{
  inserted: 470,
  skipped: 25,            // duplicates per UNIQUE(list_id, phone_e164)
  errors:  [ { row: 12, code: "INVALID_PHONE", ... }, ... ]   // 5 rows
}
```

- **Per-row validation runs before DB call** (Zod). Rows that fail
  validation are reported in `errors[]`; valid rows are still inserted.
- **createMany with `skipDuplicates: true`** handles `UNIQUE(list_id,
  phone_e164)` collisions silently — counts attributed to `skipped`.
- **The whole batch is one transaction** (Prisma createMany default).
  If the DB itself fails (deadlock, connection lost), the entire
  inserted count rolls back; client retries with same `Idempotency-Key`.
- **Order matters:** input rows preserve their `row` index in errors so
  callers (D02) can map back to source CSV line numbers.

### 5.3 Why not "all-or-nothing"?

- CSV imports of 50 000+ rows routinely contain a few dozen bad rows
  (typos, invalid phones). Hard-failing the whole batch wastes minutes
  of upload and forces the user to fix source data and re-upload.
- Industry parallel: Stripe, Twilio, Salesforce bulk APIs all use
  partial-success semantics (`207 Multi-Status` or status enums per
  record).

### 5.4 Speed budget

D01.md acceptance: **bulk insert 10 k rows ≤ 30 s**. With 500-row
chunks × 20 calls × ~1 s per call (P99 createMany on Phase-1 hardware)
= 20 s. We have headroom. If a single 500-row chunk exceeds 5 s in
production, we instrument and consider raw-SQL `INSERT ... VALUES`
which a Prisma issue [14] confirms is ~5× faster than createMany at
high row-counts on MySQL. Tracked as PLAN-time decision.

---

## 6. Optimistic locking approach

### 6.1 Choice: `version SMALLINT` column

Patterns evaluated:

| Pattern | Pros | Cons | Verdict |
|---|---|---|---|
| `If-Unmodified-Since` + `updated_at` | header-native, easy | DATETIME(6) precision still loses sub-µs collisions; clock skew across replicas | rejected per [11][12] |
| `If-Match` + ETag (hash of body) | strict, content-addressable | recompute hash on every read; heavy for fat rows | rejected — overkill |
| `If-Match` + `version` integer | simple, atomic CAS, retry-friendly | needs schema column | **CHOSEN** [13][26] |
| Pessimistic `SELECT ... FOR UPDATE` | absolutely correct | locks block hopper-filler scans | **rejected** per DESIGN.md §risks |

### 6.2 Schema impact

Add `version SMALLINT NOT NULL DEFAULT 1` to F02 leads schema as a
no-cost addition (2-byte column; SMALLINT max 32 767 wraps after 32 k
edits — survives years per lead). PLAN will file a one-line addendum
to F02 PLAN once F05 unblocks.

### 6.3 Wire shape

Both shapes accepted for client convenience:

- HTTP-canonical: `If-Match: "<version>"` (quoted per RFC 7232).
- JSON body: `{ "version": <n>, ...patch }`. If both present, header wins.

Server returns `ETag: "<new_version>"` on every mutating response so
clients can chain edits without re-fetching.

### 6.4 Conflict response

```
HTTP/1.1 412 Precondition Failed
Content-Type: application/json

{
  "error": "stale_version",
  "expected": 5,
  "actual": 3,
  "message": "Lead modified by another writer; re-fetch and retry."
}
```

Prisma update with affected-rows == 0 raises in code; we map to 412.

### 6.5 Status path (the exception)

`POST /api/leads/:id/status` does NOT require version. Per D01.md
risks: "**Concurrent status updates** — last-write-wins is OK for
status; reject if `modify_at` mismatch on critical paths." We log
both the prior status and the writer's user_id in audit_events so the
"loss" is recoverable. Critical paths (lead conversion to SALE with
financial implication) should re-introduce version check via a separate
endpoint `POST /api/leads/:id/finalize-sale` — out of D01 scope, R02
deals with it.

---

## 7. Custom-fields query strategy

Recap (Phase 1):

1. Storage: `custom_data JSON NOT NULL DEFAULT (JSON_OBJECT())`.
2. Validation: per-list Zod schema cached from `lists.custom_field_schema JSON`.
   Loaded into a per-list LRU cache (size 256, TTL 5 min, invalidated on `list.updated`).
3. Read shape: `custom_data` returned as object on detail (`GET /:id`)
   and only on list when client passes `?include=custom_data` — saves
   bandwidth for the 90 % of list views that don't need it.
4. Filter shape: `?custom.<key>=<value>` ⇒ `JSON_EXTRACT` predicate
   (unindexed Phase 1; tolerated when paired with an indexed filter).
5. Index promotion: admin-driven via `POST /api/lead-fields/:key/index`
   creates a virtual generated column + B-tree. Per [7][8] the optimizer
   auto-rewrites `JSON_EXTRACT(c,'$.k')` predicates to use the gen-col
   index — no client query change needed.
6. Prisma support: Prisma 6 lacks declarative gen-col syntax (issue
   #20663 [9]); we manage promotion via raw `$executeRawUnsafe` migration
   wrappers. Prisma reads work fine because the gen col is invisible to
   Prisma's read shape (we don't model it in `schema.prisma`).
7. Update shape: `PATCH /api/leads/:id` accepts a partial `custom_data`
   merge; we deep-merge server-side (`{...existing.custom_data, ...patch.custom_data}`)
   and re-validate against the per-list Zod schema before write. Avoids
   the "PATCH wipes other keys" foot-gun.

---

## 8. Multi-tenant enforcement

### 8.1 Layer: Prisma Client Extension

Pattern proven by `prisma-tenant-extension` [20] and `prisma-guard` [22]:

```ts
// pseudocode — actual code lives in IMPL phase
const tenantContext = new AsyncLocalStorage<{ tenantId: bigint }>();

function withTenant<T>(tid: bigint, fn: () => Promise<T>) {
  return tenantContext.run({ tenantId: tid }, fn);
}

const prisma = new PrismaClient().$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query, operation }) {
        const ctx = tenantContext.getStore();
        if (!ctx) throw new Error('tenant context required');
        if (READ_OPS.has(operation)) {
          args.where = { ...(args.where ?? {}), tenantId: ctx.tenantId };
        } else if (CREATE_OPS.has(operation)) {
          args.data = { ...(args.data ?? {}), tenantId: ctx.tenantId };
        } else if (UPDATE_OR_DELETE_OPS.has(operation)) {
          args.where = { ...(args.where ?? {}), tenantId: ctx.tenantId };
        }
        return query(args);
      },
    },
  },
});
```

Fastify plugin sets the ALS context in a `preValidation` hook from
`req.auth.tid` (set earlier by F05 JWT verify). Every request runs in
its own ALS frame; no cross-request leak.

### 8.2 Escape hatches

- `skipTenantCheck: true` (string flag) on a query — used only by F02
  migrations and by C03 audit-log compactor (system tasks). CI grep
  fails any PR adding this flag outside `api/src/system/**`.
- Cross-tenant ops (Phase 4 `super_admin`) get a separate Prisma client
  instance without the extension, behind its own RBAC gate.

### 8.3 Why not Prisma middleware (`prisma.$use`)?

Deprecated since Prisma 4.16 in favor of `$extends` [19]; doesn't
participate cleanly in `$transaction` [25]. We fully adopt `$extends`.

### 8.4 Defense-in-depth

- DB-level: every `idx_t_*` index leads with `tenant_id`; every FK is
  compound `(tenant_id, …)` per F02 PLAN §4.5.
- Service-level: ALS-bound extension above.
- API-level: F05 RBAC middleware decodes JWT and stores `tid` only on
  `req.auth`; routes never read `tenantId` from query/body.
- CI: grep blocks `where: { ...spread without tenantId` patterns and
  any raw `prisma.leads.*` outside the lead service.

---

## 9. Audit-log integration

### 9.1 What gets logged

| Action | Trigger | `details_json` content |
|---|---|---|
| `lead.created` | POST /api/leads (single + bulk per row) | inserted columns minus secrets |
| `lead.updated` | PATCH /api/leads/:id | `{before:{...}, after:{...}}` diff (only changed keys) |
| `lead.status_changed` | POST /api/leads/:id/status | `{from, to, comment}` |
| `lead.deleted` | DELETE | `{soft:true, deleted_at}` |
| `lead.restored` | POST /:id/restore | `{prior_deleted_at}` |
| `lead.recycled` | POST /:id/recycle | `{from_status, prior_called_count}` |
| `lead.bulk_inserted` | POST /bulk | `{list_id, count_inserted, count_skipped}` (one row per call, not per lead — keeps audit volume sane) |
| `lead.field_indexed` | POST /api/lead-fields/:k/index | `{key, ddl}` |

### 9.2 Pattern: outbox in same transaction

Per [29][30]: write `audit_events` row inside the same Prisma
`$transaction` as the entity write. Same transaction, atomic commit.
[31] notes the outbox guarantees: "the audit event is written to the
database atomically with the entity mutation, then delivered
asynchronously to each destination."

```ts
await prisma.$transaction(async (tx) => {
  const before = await tx.lead.findUniqueOrThrow({ where: { id, version } });
  const after  = await tx.lead.update({
    where: { id, version },
    data:  { ...patch, version: { increment: 1 } },
  });
  await tx.auditEvent.create({ data: {
    tenantId: ctx.tid,
    actorUserId: ctx.uid,
    action: 'lead.updated',
    resourceType: 'lead',
    resourceId: String(id),
    detailsJson: { before: pick(before, Object.keys(patch)), after: pick(after, Object.keys(patch)) },
    ts: new Date(),
  } });
});
```

### 9.3 Event publish: AFTER commit

Per D01.md PLAN-phase note: "Event emission timing (within tx vs after
commit; recommend after commit for at-least-once delivery)". We adopt
**after-commit** for Redis stream `events:vici2.lead.*`. The audit_events
table itself is the durable record (replay-safe); Redis stream is best-effort
for downstream consumers (E01 hopper invalidation, M03 UI websocket push).

If we later need stronger guarantees, switch to a true outbox table
(`outbox_events`) consumed by a worker, e.g. `@outbox-event-bus/postgres-prisma-outbox` [32]
pattern — but that's an O02-or-later concern.

### 9.4 No-secrets rule

Lead rows don't carry secrets per se, but `email` and `phone_e164` are
PII. `details_json` is allowed to include them (audit needs them);
log lines (Pino) must not include `details_json` content. F05 CI grep
already handles this; we add `phone_e164` and `email` to the blocklist
where they appear in stringified payloads.

---

## 10. Performance targets and how to hit them

### 10.1 Targets (measured at p95 under nominal load = 50 RPS read, 5 RPS write)

| Endpoint | p95 target | how |
|---|---|---|
| `GET /api/leads/:id` | 50 ms | PK lookup + 1-row Prisma `select`; no `include` by default; covered by InnoDB buffer pool |
| `GET /api/leads` (50 rows, 1 filter) | 200 ms | covered index; Prisma `select`; limit 51; cursor where-clause |
| `GET /api/leads/lookup?phoneE164=` | 30 ms | `idx_t_phone` lookup; LIMIT 5; agent hot path |
| `POST /api/leads` | 80 ms | E.164 normalize + Zod + insert + audit_events insert (1 transaction) |
| `PATCH /api/leads/:id` | 100 ms | version-CAS update + audit_events insert |
| `POST /api/leads/:id/status` | 80 ms | status update + agent_log insert (per spec D04) + event emit |
| `POST /api/leads/bulk` (500 rows) | 1.5 s | createMany + per-call audit_event |
| `POST /api/leads/bulk-status` (200 ids) | 600 ms | `updateMany` + bulk audit row |

D01.md says "<100 ms p95 for single lead read" and "<500 ms p95 for
paginated list (50 leads)" — we set internal targets tighter to absorb
network and FS overhead.

### 10.2 Tactics

1. **Prisma `select` everywhere on list endpoints.** Never `include`
   by default; relations cost N+1 round-trips. `expand=` query param
   opts in.
2. **Verify with `prisma:query` log inspection** during VERIFY phase —
   D01.md acceptance: "No N+1 queries in list endpoint (verified by
   query log inspection)."
3. **Cursor encoding kept tiny** — base64 of a 60-byte JSON ⇒ 80-char
   cursor, fits in a URL.
4. **Compression enabled at Fastify** (`@fastify/compress`) for list
   endpoints — JSON arrays of 50 leads compress 5–10×.
5. **Server-side defaulting of `include=custom_data`**: omit unless
   client opts in; wide JSON columns blow up response size by 2–10×.
6. **Read-heavy cache: `GET /api/leads` and only that.**
   - Key = `t:{tid}:leads:list:{sha1(canon_query)}`
   - Value = serialized response
   - TTL = 30 s
   - Invalidator: pubsub on `events:vici2.lead.*` flushes the prefix
     `t:{tid}:leads:list:*` (Redis SCAN+UNLINK).
   - **Lookup-by-phone NOT cached** — agent must see the freshest lead.
7. **Connection pool sizing** — Prisma default 10; raise to
   `num_cpus*2 + 1` per Prisma docs; on a 4-vCPU API box that's 9 → 9.
   Bulk endpoint runs createMany on a single connection so the pool
   isn't starved by concurrent bulk POSTs.
8. **Request body size limit** — Fastify default 1 MB — too small for
   500-row bulk. Set to **4 MB** for `/api/leads/bulk` only via route
   options.
9. **Index hint annotations** — Prisma raw fallback `// @@useIndex` is
   not supported, but our query shapes already match the F02 indexes;
   `EXPLAIN` checked in IMPL.

### 10.3 Load-test plan (to be executed in O03)

- k6 scripts in `scripts/load-test/leads-*.js`
- Scenarios: read-list, single-create, bulk-500, lookup-burst, mixed.
- Pass criteria: p95 hits the table above under 100 RPS aggregate.

---

## 11. Open questions for PLAN

1. **Status enum source of truth.** D04 owns `statuses` per campaign
   but D01 must validate status writes. Confirm: D01 calls a D04-owned
   helper `isValidStatus(tenantId, campaignId, status)` synchronously
   (in-memory cache with 5-min TTL) — or do we duplicate the lookup?
   PLAN locks in once D04 RESEARCH lands.
2. **Recycle endpoint behavior.** D06 spec says callbacks call
   `/recycle` to re-add a lead. Does recycle reset `called_count` to
   0, or just `last_called_at`? Per Vicidial parallel ([34]
   `called_since_last_reset` flag), Vicidial leaves `called_count` and
   resets a separate flag. We propose mirroring: add a
   `dialable_after DATETIME(6) NULL` column (or reuse `modify_at` set
   to NOW(6)) — defer to D06 RESEARCH.
3. **Idempotency-Key TTL.** 24 h is industry norm (Stripe). For our
   CSV importer that may retry within minutes, that's plenty. Confirm
   24 h or shorten to 1 h to bound Redis memory.
4. **Bulk endpoint `error_strategy`.** Should we expose a `?strict=true`
   mode that flips to all-or-nothing semantics (rolls back on any
   per-row error)? Useful for transactional CRM sync (N01). Propose:
   yes, default `strict=false`, toggle in body.
5. **`If-Match` parser strictness.** Strong vs weak ETag prefix
   (`W/"5"` vs `"5"`) — accept both, require strong on write?
   Recommendation: accept both, treat as strong (we never serve weak).
6. **Cursor stability on sort change.** If a client paginated under
   `sort=modify_at_desc` and changes to `sort=created_at_desc`
   mid-stream, the cursor is invalid. We reject `400 cursor_sort_mismatch`
   forcing a re-start. Confirm UX is OK.
7. **Custom-field index promotion authorization.** Who can call
   `POST /api/lead-fields/:k/index`? `lead:edit` is too low (DDL is
   blocking online but adds gen-col cost forever). Propose: `super_admin`
   only.
8. **Search scope.** `?search=` currently scans last/first/email/vendor.
   Add `phone_e164` (requires LIKE on indexed column — slow with
   leading `%`). Recommendation: don't, point users to `/lookup` for
   phones.
9. **Soft-delete sweep.** `deleted_at IS NOT NULL` rows accumulate
   forever. Should D01 ship a `cron/sweep-deleted.ts` worker that
   hard-deletes rows older than 90 d (TCPA / GDPR aware)? Propose: yes
   but separate spec module (compliance C04 territory).
10. **OpenAPI spec ownership.** D01 owns `/api/leads/*` slice of
    `shared/openapi/openapi.yaml`. PLAN must list which `paths` and
    `components/schemas` D01 contributes vs which it shares (Lead
    schema is the obvious cross-module type).

---

## 12. Citations

1. **Zalando RESTful API Guidelines — Pagination** — https://github.com/zalando/restful-api-guidelines/blob/main/chapters/pagination.adoc — SHOULD prefer cursor-based; avoid offset; opaque cursor; avoid total counts.
2. **Botneve — API Pagination Patterns at 1K/100K/10M (2026)** — https://botneve.com/api-design/api-pagination-patterns/ — performance-by-depth tables; recommends cursor for >10K records.
3. **Apidog — How to Design API Pagination for Millions (2026)** — http://apidog.com/blog/how-to-design-api-pagination-millions-of-records/ — opaque cursor pattern; max limit 100; PetstoreAPI HATEOAS cursor.
4. **APIScout — API Pagination 2026: Cursor vs Offset** — https://apiscout.dev/blog/api-pagination-patterns-cursor-vs-offset-2026 — cursor right default for production; never expose `COUNT(*)`.
5. **REST API Pagination Guide** — https://www.restguide.info/pagination.html — comparison matrix incl. keyset; defaults `limit=20` `max_limit=100`.
6. **Codelit.io — Pagination Patterns 2026** — https://codelit.io/blog/api-pagination-patterns — keyset SQL with `(created_at, id)` tiebreaker; cursor base64-encoded.
7. **MySQL 9.7 Reference Manual — Secondary Indexes and Generated Columns** — https://dev.mysql.com/doc/refman/9.7/en/create-table-secondary-indexes.html — virtual gen cols + secondary indexes for JSON; optimizer auto-rewrites `JSON_EXTRACT` predicates.
8. **MySQL Blog — Indexing JSON Documents via Virtual Columns** — https://dev.mysql.com/blog-archive/indexing-json-documents-via-virtual-columns/ — `ALTER TABLE ADD col AS (JSON_UNQUOTE(...)) VIRTUAL; ADD INDEX(col)` — instant DDL for VIRTUAL.
9. **Prisma Issue #20663 — BTREE index for `Json` sub-property paths** — https://github.com/prisma/prisma/issues/20663 — Prisma lacks declarative JSON-path indexes; raw migration required.
10. **Prisma Issue #8835 — Full-Text search on `Json` field via computed columns** — https://github.com/prisma/prisma/issues/8835 — community pattern: gen col + index, queried via Prisma's `path:` JSON filter.
11. **Kenneth Lange — Avoid Data Corruption with REST API ETags** — http://www.kennethlange.com/posts/rest_api_etags.html — `If-Unmodified-Since` is per-second, loses sub-second writes; ETag is safer.
12. **Michael Scharhag — REST API: Dealing with Concurrent Updates** — https://www.mscharhag.com/api-design/rest-concurrent-updates — `If-Match` strong validators recommended; `If-Unmodified-Since` weak.
13. **Tech Interview Dot Org — Optimistic Locking LLD: Version Columns, CAS, Retry (2026)** — https://www.techinterview.org/post/3233469275/lld-optimistic-locking/ — version-column CAS; ETag mirror; exponential backoff.
14. **Prisma Docs — Transactions and batch queries** — https://www.prisma.io/docs/orm/prisma-client/queries/transactions — `createMany`/`updateMany`/`deleteMany` are transactional; isolation level table.
15. **Prisma PR #1550 — `createMany` operation** — https://github.com/prisma/prisma-engines/pull/1550 — `skipDuplicates` for MySQL/Postgres; row caps.
16. **Prisma Issue #23791 — `createMany` with large object slower in Prisma 5** — https://github.com/prisma/prisma/issues/23791 — perf note + raw `INSERT VALUES` ~5× faster fallback.
17. **catamphetamine/libphonenumber-js README** — https://github.com/catamphetamine/libphonenumber-js — `/min` 80 KB, `/max` 145 KB; E.164 parsing via `parsePhoneNumberFromString`.
18. **catamphetamine/libphonenumber-js Issue #421 — isValid and E.164** — https://github.com/catamphetamine/libphonenumber-js/issues/421 — E.164 length cap (15 digits); use `/max` for strict validity.
19. **Prisma Docs — Client Extensions (`$extends`)** — https://www.prisma.io/docs/concepts/components/prisma-client/middleware — modern replacement for `$use` middleware; chainable; supports `query.$allModels.$allOperations`.
20. **baileywickham/prisma-tenant-extension (Jan 2026)** — https://github.com/baileywickham/prisma-tenant-extension — automatic tenant filter injection via `$extends`; AsyncLocalStorage context.
21. **Nexis — 8 Advanced Prisma ORM Patterns for Production TS (2026)** — https://nexisltd.com/blog/prisma-orm-advanced-patterns-typescript — multi-tenant filtering with `$extends`; soft-delete middleware example.
22. **multipliedtwice/prisma-guard (March 2026)** — https://github.com/multipliedtwice/prisma-guard — type-safe automatic scope injection; whitelisted shapes per role; AsyncLocalStorage context.
23. **@fastify/rate-limit README** — https://github.com/fastify/fastify-rate-limit — `keyGenerator`, `groupId`, Redis-backed store, async `max` for per-tenant tiers.
24. **@hyperlimit/fastify (Jan 2026)** — https://www.npmjs.com/package/@hyperlimit/fastify — alternative with per-tenant lock-free dynamic config; reference for tier-based rate limits.
25. **Lewis Blackburn — Prisma Dynamic Context and Audit Logs** — https://lewisblackburn.me/blog/prisma-dynamic-context-and-audit-logs — Prisma middleware vs `$extends` interaction with `$transaction`; argues for `$extends`.
26. **Microsoft Azure API Guidelines — ETag & Optimistic Concurrency** — https://github.com/microsoft/api-guidelines/issues/257 — version vs hash trade-off; recommends hash for retry-safety; both acceptable.
27. **MySQL 8.4 Reference Manual — InnoDB Full-Text Indexes** — https://dev.mysql.com/doc/en/innodb-fulltext-index.html — FTS updates at COMMIT time; auxiliary tables; rejection rationale for hot-write tables.
28. **Stack Overflow — Optimizing MySQL LIKE Query for 20M+ records (2025)** — https://stackoverflow.com/questions/79571812 — FTS / LIKE performance trade-offs; substring search is hard in MySQL.
29. **Volodymyr Gaevoy — Audit log via transactional outbox (2021)** — https://gaevoy.com/2021/03/18/audit-log-via-transactional-outbox.html — outbox pattern, eventually consistent, atomic with entity write.
30. **AuthHero — Audit Events architecture** — https://www.authhero.net/architecture/audit-events — request-scoped DB transaction wrapping entity + outbox; at-least-once relay.
31. **@outbox-event-bus/postgres-prisma-outbox** — https://registry.npmjs.org/%40outbox-event-bus%2Fpostgres-prisma-outbox — Prisma `$transaction` + outbox event emission; AsyncLocalStorage helper pattern.
32. **Vicidial Non-Agent API documentation** — https://www.vicidial.org/docs/NON-AGENT_API.txt — `add_lead`, `update_lead`, `lead_search`, custom-field handling, list/entry_list_id semantics — direct comparison points for D01.
33. **ViciWiki — vicidial_list table structure** — http://viciwiki.com/index.php/Vicidial_Database_Structure — full vicidial_list column inventory, `entry_list_id` for custom-field home-list link, `called_since_last_reset` flag.
34. **Vicidial Forum — Custom List Fields feature (2010)** — https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=12191 — origin and design of Vicidial custom fields (per-list, separate `custom_<list_id>` table) — contrast with our `custom_data JSON` choice.
35. **Leapcell — Sharing Types and Validations with Zod Across a Monorepo (Oct 2025)** — https://leapcell.io/blog/sharing-types-and-validations-with-zod-across-a-monorepo — `@fastify/zod` validation pattern; `z.infer` shared with Next.js consumer.
36. **fastify-lor-zod (March 2026)** — https://registry.npmjs.org/fastify-lor-zod — Zod v4 native Fastify type provider with OpenAPI generation; `jsonSchemaTransform` for `@fastify/swagger`.

---

## 13. Comparison with Vicidial

| Concern | Vicidial | vici2 D01 | Why we differ |
|---|---|---|---|
| Lead table name | `vicidial_list` | `leads` | clarity; `_list` connotation is wrong |
| Custom fields | per-list MySQL table `custom_<list_id>` with explicit columns | single `custom_data JSON` column + per-list Zod schema | avoids per-list DDL; Phase-2 escape hatch defined for indexed lookups |
| Phone normalization | not enforced; perl regex on import | libphonenumber-js E.164 mandatory at write | reduces dial errors; consistent inbound match |
| API style | flat key=value POST/GET — `add_lead`, `update_lead`, `lead_search` etc. | REST resource model `/api/leads`, `/:id`, `/lookup`, `/bulk` | predictability; OpenAPI generation; ergonomic typing |
| Pagination | none built-in; admin UI uses LIMIT | cursor-based `(modify_at, id)` | scales beyond a single screen |
| Version / locking | none — last write wins on UPDATE | `version` column + If-Match | required for multi-agent admin UI editing |
| Tenancy | none (single-tenant install) | `tenant_id` enforced everywhere | day-1 multi-tenant readiness |
| Audit | optional `vicidial_log` rows; not transactional | mandatory `audit_events` row inside same transaction | SOC 2; recoverability |
| RBAC | numeric `user_level` 0–9 | F05 verb-based perms (`lead:read`, `lead:edit`, `lead:import`, `lead:delete`) | finer-grained; standard pattern |
| Bulk ingest | `add_list` web form + custom file format | `POST /api/leads/bulk` + D02 CSV importer | both server- and SDK-friendly |
| Soft delete | none — DELETE is hard | `deleted_at` column + filter | preserves history for callbacks/recordings |
| Recycle | `called_since_last_reset` flag reset by perl cron | `POST /:id/recycle` driven by D06 callbacks | explicit, observable |

---

**End of RESEARCH.md.** PLAN is blocked on F05 PLAN landing (RBAC verb
matrix + middleware shape). Once F05 PLAN merges, D01 PLAN can proceed
in ~1 day and unblocks D02 (CSV import), A04 (manual dial), E01 (hopper
filler).
