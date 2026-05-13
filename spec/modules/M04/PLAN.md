# M04 — Audit Log Viewer — PLAN

**Module:** M04
**Status:** PLAN
**Date:** 2026-05-13
**Branch:** feat/M04-implement
**Depends on:** C03 (AuditWriter, AuditVerifier, AuditReader), M01 (admin UI shell), M08 (attestations pattern), F05 (RBAC/JWT)

---

## 0. TL;DR (8 bullets)

1. **M04 is read-only.** All DB access uses the existing `AuditReader` service (which in turn uses `vici2_audit_reader` credentials). No schema changes.
2. **Five API endpoints** under `/api/admin/audit-log/` and `/api/admin/audit-attestations/` support browsing, drill-down, row/day verification, and export.
3. **Cursor pagination** on all list endpoints; cursor = `base64(id)`; hard cap 200 rows per page; leverages `(tenant_id, hash_at)` index.
4. **Chain verification** delegates entirely to the existing `AuditVerifier.verifyRow()` and `AuditVerifier.verifyDay()` — M04 does NOT re-implement crypto.
5. **RBAC:** `audit:view` for list/detail/export; `audit:export` for CSV/JSON download (both already granted to `admin`, `super_admin`, and `viewer` roles). No new verbs needed.
6. **Meta-audit:** every M04 read emits an `audit_log.read` event via `AuditReader` (already built into the service).
7. **Web UI:** Next.js pages under `web/src/app/(admin)/admin/audit/` — index list, detail drill-down, attestation registry; client components.
8. **Tests:** schema unit tests (Zod shapes), service unit tests (cursor math, RBAC rejection), handler integration tests (mock Prisma + AuditVerifier).

---

## 1. Files to create

```
api/src/routes/admin/audit/
  index.ts              — route registration (all 5 endpoints)
  schema.ts             — Zod schemas for query params and responses
  service.ts            — AuditLogViewerService (thin wrapper over AuditReader/Verifier)
  metrics.ts            — Prometheus counters

api/test/admin/audit/
  schema.test.ts        — Zod schema unit tests
  service.test.ts       — service unit tests (cursor, RBAC, verify delegation)

web/src/app/(admin)/admin/audit/
  page.tsx              — server shell for audit log list
  [id]/
    page.tsx            — server shell for audit log detail
  attestations/
    page.tsx            — server shell for attestation registry

web/src/components/admin/audit/
  AuditLogTable.tsx     — cursor-paginated list with filters
  AuditLogDetail.tsx    — single row drill-down + chain context
  AuditVerifyBadge.tsx  — green/red verification badge
  AttestationTable.tsx  — attestation registry + verify button

spec/modules/M04/
  PLAN.md               — this file
```

---

## 2. API surface

| Method | Path | RBAC verb | Notes |
|---|---|---|---|
| GET | `/api/admin/audit-log` | `audit:view` | Filter: action, actor, target, from, to, severity, cursor, limit |
| GET | `/api/admin/audit-log/:id` | `audit:view` | Full payload + prev/next 5 chain context rows |
| GET | `/api/admin/audit-log/:id/verify` | `audit:view` | Delegates to AuditVerifier.verifyRow() |
| GET | `/api/admin/audit-log/export` | `audit:export` | CSV or JSON (Accept header); streams |
| GET | `/api/admin/audit-attestations` | `audit:view` | Filter: table, from, to, cursor |
| GET | `/api/admin/audit-attestations/:id/verify` | `audit:view` | Delegates to AuditVerifier.verifyDay() |

---

## 3. Query parameter schemas (Zod)

### AuditLogListQuerySchema
```typescript
{
  action?: string;        // exact or prefix-match
  actor?: string;         // userId (numeric string)
  actorKind?: enum('user','system','worker','external_api');
  entity_type?: string;
  entity_id?: string;
  from?: string;          // ISO date YYYY-MM-DD
  to?: string;            // ISO date YYYY-MM-DD
  severity?: enum('SEV1','SEV2','SEV3');
  cursor?: string;        // base64(id)
  limit?: number;         // default 50, max 200
}
```

### AuditLogDetailResponse
```typescript
{
  row: AuditLogRow;
  chainContext: {
    prevRows: AuditLogRow[];   // up to 5 before
    nextRows: AuditLogRow[];   // up to 5 after
  };
}
```

### VerifyRowResponse
```typescript
{
  ok: boolean;
  rowHashRecomputed: string;
  rowHashStored: string;
  prevRowHashMatches: boolean;
  nextRowPrevHashMatches: boolean;
  merkleAttestationDate: string | null;
  failures: VerifierFailure[];
  rowsChecked: number;
  daysChecked: number;
  attestationsChecked: number;
}
```

### AttestationListQuerySchema
```typescript
{
  table?: string;         // e.g. 'audit_log', 'consent_log'
  from?: string;          // YYYY-MM-DD
  to?: string;            // YYYY-MM-DD
  cursor?: string;
  limit?: number;         // default 50, max 200
}
```

---

## 4. Service layer (AuditLogViewerService)

Thin wrapper that:
1. Converts `req.query` types to what `AuditReader` expects
2. Adds additional filter clauses not in `AuditReader.list()` (action, actor, entity_type, entity_id)
3. Fetches chain context (prev/next 5 rows) for detail view
4. Delegates verify calls to `AuditVerifier`
5. Streams CSV/JSON for export

The service does NOT re-implement pagination or hashing — it delegates.

### Cursor pagination math
```
cursorId = cursor ? BigInt(Buffer.from(cursor, 'base64').toString()) : null
WHERE id > cursorId
ORDER BY id ASC
LIMIT limit+1
hasMore = rows.length > limit
nextCursor = hasMore ? Buffer.from(String(rows[limit-1].id)).toString('base64') : null
```

### Chain context query
```sql
-- prev 5
SELECT * FROM audit_log
WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 5

-- next 5
SELECT * FROM audit_log
WHERE tenant_id = ? AND id > ? ORDER BY id ASC LIMIT 5
```

---

## 5. Prometheus metrics

```typescript
audit_viewer_requests_total{ endpoint, status }
audit_viewer_verify_total{ table, result }  // result: ok | fail
audit_viewer_export_bytes_total{ format }
```

---

## 6. Web UI pages

### `/admin/audit` — List page
- Filters: action (text), actor user ID (text), from/to date pickers, table dropdown
- Table: id, ts, action, actor_kind, actor_user_id, entity_type, entity_id, row_hash (truncated)
- Cursor pagination: "Load more" button (not offset)
- Export button → calls `/api/admin/audit-log/export?format=csv`
- Click row → navigates to `/admin/audit/[id]`

### `/admin/audit/[id]` — Detail page
- Full row display: all columns, pretty-printed JSON for before_json/after_json
- Chain context: prev 5 + next 5 rows in a mini-table
- Verify button → calls `/api/admin/audit-log/:id/verify` → shows AuditVerifyBadge
- Badge: green (ok=true), red (ok=false with failure list), grey (loading)

### `/admin/audit/attestations` — Attestation registry
- Table: id, table_name, window_date, row_count, merkle_root (truncated), computed_at, s3_key
- Filter: table, from/to dates
- Verify button per row → calls `/api/admin/audit-attestations/:id/verify`
- Shows row_count, merkle_root match, signature status

---

## 7. Export format

### CSV
```
id,ts,action,actor_kind,actor_user_id,entity_type,entity_id,row_hash,prev_hash
```
Streamed with `Content-Disposition: attachment; filename="audit_log_<from>_<to>.csv"`.

### JSON
Streamed newline-delimited JSON (one object per line).

Both formats respect the same filter params as the list endpoint.

---

## 8. RBAC guard pattern (matches M01)

```typescript
{ preHandler: [app.requireAuth, app.requirePermission('audit:view')] }
// export endpoint:
{ preHandler: [app.requireAuth, app.requirePermission('audit:export')] }
```

---

## 9. Test plan

- **schema.test.ts:** AuditLogListQuerySchema defaults, coercion, caps; AttestationListQuerySchema
- **service.test.ts:**
  - cursor math: first page (no cursor), next page (cursor set), last page (hasMore=false)
  - RBAC rejection: throws 403 when permission missing
  - verify delegation: verifyRow called with correct params; result passed through unchanged
  - export: CSV header row correct; JSON lines parseable
- All tests use mock Prisma (`vi.fn()`) and mock AuditVerifier

---

## 10. Out of scope for M04

- Merkle tree UI visualization (future M04.2)
- S3 attestation download links (requires S3 env; deferred)
- Cross-tenant audit viewing (super_admin cross-tenant; deferred to M04.3)
- Real-time audit stream (WebSocket; deferred)

---

End of PLAN.md.
