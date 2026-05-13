# D02 — Lead List CSV Import — PLAN

| Field | Value |
|---|---|
| Module | D02 (Data track, Phase 1) — bulk lead-import pipeline |
| Author | D02-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Status | PROPOSED — awaiting orchestrator/human review |
| Companion | [RESEARCH.md](./RESEARCH.md) — 38 citations |
| Depends on (PLANs FROZEN) | D01 (`LeadService.bulkInsert`), D05 (DNC scrub), C01 (TCPA tz gate), F02 (schema + AMENDMENTS-HANDOFF), F04 (Valkey + BullMQ), F05 (RBAC + multipart auth) |
| Blocks | M03 (admin lead UI), N01 (Phase 4 external bulk add-lead), C04 (retention sweep over `imports` tables) |

This plan converts D02 RESEARCH findings into a frozen REST contract, streaming pipeline architecture, BullMQ worker pattern, schema additions, error reporting shape, DNC/TCPA integration, progress delivery mechanism, performance targets, and test strategy. Once accepted, the public surface (endpoint shapes, table schemas, error code vocabulary, SSE event names, column-mapping wire shape) is FROZEN. Internal implementation details (Transform highWaterMark tuning, chardet confidence thresholds, Bloom MEXISTS batch size) may evolve without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **Pipeline = 7 `Transform` stages connected by `stream/promises.pipeline()`**, never by `.pipe()`. Stages: `source` → `encoding-detect` → `csv-parse` → `apply-mapping` → `normalize-and-validate` → `in-file-dedup` → `DNC+TCPA-scrub` → `batch-of-500` → `db-writer` (Writable). Native Node backpressure governs parser read rate automatically; no custom high-watermark tuning required for the memory contract (`≤ 200 MB heap on 1 M rows`).

2. **CSV parser = `csv-parse@^5.5.0`**, pinned options `{ bom: true, info: true, relax_quotes: true, skip_records_with_error: false, trim: true, max_record_size: 1048576, columns: false }`. TSV/semicolon auto-detected from first 4 KB (delimiter frequency). XLSX deferred to Phase 1.5 (`exceljs@^4 stream.xlsx.WorkbookReader`). Encoding: UTF-8/BOM, UTF-16LE/BOM, Windows-1252 (via `node-chardet` + `iconv-lite`); others reject `400 UNSUPPORTED_ENCODING`.

3. **D01 service layer called directly** (`LeadService.bulkInsert`), not via REST loopback. Per-batch ULID idempotency key derived as `ULID(import_id + ':batch:' + batchIndex)` — satisfies D01 PLAN §1.4 24-hour Valkey cache semantics. HTTP rate-limit (10 rpm) is bypassed; the trusted worker is not an external client.

4. **BullMQ over Valkey** (`F04 queue: 'vici2:queue:lead-import'`), concurrency 2 per worker pod, **sandboxed processor** (`processor.cjs`). Job options: `attempts:3, backoff: {type:'exponential', delay:5000}`. Sandboxing isolates the CSV hot loop — a `csv-parse` crash does not orphan the queue worker.

5. **Column mapping persisted on `lists.column_mapping JSON NULL`** (F02 amendment §4.3). First-upload: server returns `header_preview` (first 100 rows); UI shows drag mapping; operator confirms. Subsequent uploads: `mapping: "inherit"`. Auto-detect heuristics seed the initial mapping (case-insensitive substring match) but operator confirmation is mandatory before processing starts.

6. **DNC scrub on import is policy-configurable**: `dnc_policy: 'skip'|'mark'|'proceed'`, default **`skip`**. Implemented in the DNC+TCPA Transform via D05's Bloom MEXISTS pipeline per batch of 100 phones (sub-millisecond). TCPA timezone gate: `tz_policy: 'skip'|'mark'|'proceed'`, default **`mark`** (sets `leads.tz_blocked=true`; C01 at dial time is authoritative). D02 does **not** call C01.Check() at import time — D03 confidence is the only import-time signal.

7. **Three dedup layers**: (1) within-file `Set<string>` of E.164 phones (always-on, 16 MB ceiling for 1 M rows); (2) target-list dedup via D01's `createMany({skipDuplicates:true})` — enforced by F02's `UNIQUE(tenant_id, list_id, phone_e164)`; (3) tenant-wide cross-list batch `SELECT` (opt-in, default off). Recycle-aware dedup deferred to D06.

8. **Error report = `errors.csv`** (sibling file on S3/local). Shape: original columns + `_source_line, _source_record, _error_code, _error_message`. Streamed in parallel via `csv-stringify@^6` Writable. 18 stable error codes (FROZEN vocabulary). `import_errors` table stores structured rows (optional `rawRow` default off). Errors capped at `10 000` per import (`MAX_ERRORS_EXCEEDED`).

9. **Progress via SSE** at `GET /api/admin/imports/:id/events` (`text/event-stream`). Worker calls `job.updateProgress({processed, total, inserted, skipped, errored})` every 1 000 rows; BullMQ publishes to Valkey; API gateway Fastify handler re-emits as `event: progress`. Heartbeat every 15 s prevents NGINX proxy buffer timeout. 5-second polling fallback via `GET /api/admin/imports/:id` for clients without EventSource support.

10. **Performance targets**: ≥ 1 000 rows/sec (acceptance floor); ≥ 5 000 rows/sec stretch via D01 raw-INSERT fallback (Prisma issue #23791). 1 M-row CSV ≤ 200 MB heap throughout. 10 k-row CSV ≤ 30 s end-to-end. UI progress visible within 1 s of worker start. DB writer is the throughput bottleneck; csv-parse and normalizer are not.

---

## 1. Goals and non-goals

### 1.1 Goals

- Asynchronous CSV/TSV ingestion: admin uploads → file lands on S3/local → BullMQ worker streams it row-by-row → normalizes phones → validates against per-list `custom_data` schema → writes via `D01.LeadService.bulkInsert` → reports progress and errors back to UI.
- Memory-bounded: 1 M-row CSV imports without OOM; heap stays under 200 MB throughout.
- Resumable: job retried up to 3× on transient failure; operator can re-submit same `import_id` with `?resume=true` to continue from checkpoint.
- Per-row error fidelity: errors.csv includes original row + source line number + stable error code. No row silently swallowed.
- Idempotent: re-uploading the same CSV under the same `import_id` does not double-insert leads (per-batch ULID idempotency keys).
- Compliance-aware: DNC scrub on import (D05 Bloom gate) and TCPA tz derivation (D03 cascade) before write.
- Column-mapping persistence: header mapping saved per list; reused on next upload without operator re-mapping.

### 1.2 Non-goals (explicit deferrals)

- **Lead insertion logic** — D01 (`LeadService.bulkInsert`). D02 is a caller, not the writer.
- **Custom-data schema validation** — D01 owns the per-list Zod schema cache. D02 passes rows through D01's validator.
- **Phone normalization implementation** — D01 owns `api/src/leads/normalize.ts`. D02 imports.
- **DNC lookup** — D05 owns the Bloom topology and `Check()`. D02 calls per-batch.
- **TZ resolution** — D03 owns the 6-tier cascade. D02 calls `tz.Resolve()` for confidence-level tagging.
- **TCPA gate enforcement** — C01 at dial time (E01 hopper + T04 originate) is authoritative. D02 only sets `tz_blocked` based on D03 confidence.
- **XLSX in Phase 1** — operators "Save As CSV"; XLSX ships Phase 1.5.
- **Recycle-aware dedup** — D06 territory (Phase 2).
- **Import cancellation** — Phase 2 feature.
- **N01 external add-lead** — separate REST surface; reuses some D02 plumbing but is its own module.
- **Parallel shard splitting** — Phase 2 (BullMQ Flow Producer; single worker satisfies Phase 1 acceptance).

---

## 2. Pipeline architecture (streaming, backpressure)

### 2.1 Stage diagram

```
S3 / disk file  (≤ 500 MB; 10 M rows × 50 B/row worst case)
  │  fs.createReadStream() / s3.getObject().createReadStream()
  ▼
[ Stage 1: encoding-detect Transform ]
    chardet.detectFile(path, {sampleSize:32768}) → if windows-1252 confidence > 0.7,
    prepend iconv-lite decode; UTF-16BE BOM → iconv-lite; else pass through.
    Output: raw bytes, utf8-safe.
  ▼
[ Stage 2: csv-parse Transform ]
    options: { bom, info, relax_quotes, skip_records_with_error:false,
               trim, max_record_size:1MB, columns:false, delimiter:<detected> }
    Each record emitted as { record: string[], info: {lines, records, columns} }
  ▼
[ Stage 3: apply-mapping Transform ]
    Loads lists.column_mapping (cached; snapshotted at import-start).
    Applies source→target column remap and transform functions
    (phone, date:<fmt>, lower, upper, trim, nullify_blank, parseInt, parseFloat,
     map:<k>=<v>, concat:<col>).
    Emits { mapped: Record<target,value>, rawRecord: string[], info }
  ▼
[ Stage 4: normalize-and-validate Transform ]
    phone_e164: libphonenumber-js/min (import D01 normalize.ts).
    state: 2-letter US set or derive from ZIP via zip_codes table (cached Map).
    date_of_birth: date-fns parse with format from mapping.
    custom_data: D01 per-list Zod schema (LRU cache size 256, TTL 5 min).
    Errors → errors-stream (see §2.2). Valid rows passed downstream.
  ▼
[ Stage 5: in-file-dedup Transform ]
    Set<string> of E.164 phones seen in this file (16 MB ceiling for 1 M rows).
    Second occurrence → errors-stream with code:DUPLICATE_IN_FILE.
    Tenant-wide dedup (opt-in): batch SELECT per 500 rows on idx_t_phone.
  ▼
[ Stage 6: DNC + TCPA-scrub Transform ]
    Per batch of 100 phones:
      D05 Bloom MEXISTS pipeline → MySQL confirm on positive.
    Per row:
      D03.Resolve(phone, zip, state) → tz confidence.
    Apply dnc_policy and tz_policy. DNC/tz-blocked rows → errors-stream.
  ▼
[ Stage 7: batch-of-500 Transform ]
    Accumulates 500 rows, emits one array.
  ▼
[ db-writer Writable ]
    LeadService.bulkInsert(batch, { skipDuplicates:true, strict:false,
      idempotencyKey: ulid(importId + ':batch:' + batchIndex),
      auditContext: { import_id, owner_user_id } })
    After each batch: UPDATE imports SET row_count_* = ... WHERE id = ?
    await job.updateProgress({processed, total, inserted, skipped, errored})

In parallel (same pipeline call):
[ errors-stream → csv-stringify Writable ]
    Streams to import_errors.csv on S3/local.
    Optionally INSERT into import_errors table (per meta.options.persist_raw_errors).
```

Wired with `stream/promises.pipeline(source, stage1, stage2, ..., dbWriter)` (Node 20 canonical; `.pipe()` chains are not used).

### 2.2 Backpressure model

Each Transform runs in object mode with `highWaterMark: 16` (16 records buffered between stages). The db-writer `Writable` is the slowest stage; its `_write(batch, _, cb)` calls `LeadService.bulkInsert()`, awaits, then calls `cb()`. This causes automatic backpressure propagation up the chain — the csv-parse stage stops reading the file until the DB write returns. No manual pause/resume logic required.

### 2.3 Memory budget (1 M rows)

| Source | Per-row | Total | Strategy |
|---|---:|---:|---|
| csv-parse ring buffer | — | ~64 KB | constant |
| Buffered objects (highWaterMark × 7 stages × 16) | 200 B | ~22 KB | constant |
| Batch accumulator (500 rows) | 200 B | 100 KB | constant |
| In-file dedup Set (1 M E.164 phones × ~16 B) | — | **16 MB** | pre-allocated; constant |
| DB-writer in-flight request | 200 B × 500 | 100 KB | constant |
| Node runtime | — | ~30 MB | constant |
| **Total estimated peak** | | **~47 MB** | well under 200 MB ceiling |

`max_record_size: 1048576` (1 MB) caps the pathological single-wide-row case. Heap memory profiled via `process.memoryUsage()` logged every 100 batches during VERIFY.

### 2.4 Throughput targets

| Stage | Throughput estimate | Bottleneck? |
|---|---:|---|
| csv-parse | ~250 k rows/sec | No |
| normalize + Zod | ~25 k rows/sec | No |
| DNC Bloom MEXISTS (per-100 pipeline) | ~50 k phones/sec | No |
| D03 TZ resolve (NPA/NXX hashmap) | ~100 k/sec | No |
| `LeadService.bulkInsert` Prisma (500 rows, p95 ≤ 1.5 s) | ~333 rows/sec | **Yes** |
| D01 raw-INSERT fallback (optional) | ~1 600 rows/sec | — |

Phase 1 acceptance: **≥ 1 000 rows/sec** sustained. Stretch target: **≥ 5 000 rows/sec** with raw-INSERT fallback. A 1 M-row import takes ~17 minutes at Phase 1 floor; ~3.5 minutes with the fallback.

---

## 3. File format support

### 3.1 CSV (primary)

RFC 4180 with extensions:
- Embedded newlines inside quoted fields: handled natively by csv-parse (info.lines = starting line of record).
- CRLF and LF-only both auto-detected.
- CR-only (legacy Mac): `csv-parse record_delimiter: ['\n', '\r\n', '\r']`.
- Field count mismatch: per-row error `FIELD_COUNT_MISMATCH`.
- Backslash escape (non-RFC 4180): rejected by default; opt-in via `meta.options.legacy_backslash_escape: true` (Phase 2).
- `relax_quotes: true` tolerates stray unescaped quotes from legacy CRM exports.

### 3.2 TSV and semicolon-delimited

Auto-detect: scan first 4 KB of file; if `\t` count > `,` count → TSV; if `;` count dominant → semicolon (European Excel). Override via `meta.delimiter: ','|';'|'\t'|'auto'` (default `'auto'`).

### 3.3 Encoding

| Encoding | Detection | Handling |
|---|---|---|
| UTF-8 (with or without BOM) | csv-parse `bom:true` | Default path; no overhead |
| UTF-16 LE (BOM `FF FE`) | csv-parse `bom:true` | Handled natively |
| UTF-16 BE (BOM `FE FF`) | Sniff first 2 bytes | `iconv-lite` decode Transform prepended |
| Windows-1252 / Latin-1 | `node-chardet` confidence > 0.7 | `iconv-lite` decode Transform prepended; ~5% parse overhead |
| Other | `node-chardet` returns unknown | `400 UNSUPPORTED_ENCODING` with "Save as UTF-8" hint |

### 3.4 XLSX — Phase 1.5 (documented, not shipped Phase 1)

Library: `exceljs@^4` `stream.xlsx.WorkbookReader({ sharedStrings:'cache', styles:'ignore', hyperlinks:'ignore', worksheets:'emit' })`. Memory advantage: ~70 MB peak heap for 100 k × 10-col XLSX vs ~420 MB for SheetJS — the 6× RAM savings makes it the clear winner over SheetJS for large files. Phase 1.5 implementation replaces Stage 2 csv-parse Transform with an async-iterator over ExcelJS rows; all downstream stages are format-agnostic.

### 3.5 Gzip — Phase 2

`.csv.gz` and `Content-Encoding: gzip` rejected in Phase 1 with `400 UNSUPPORTED_FORMAT`. Phase 2: pipe through `zlib.createGunzip()` in the encoding-detect stage.

---

## 4. Schema additions (imports + import_errors tables)

### 4.1 New table: `imports`

```prisma
model Import {
  id                String       @id @db.Char(26)          // ULID
  tenantId          BigInt       @default(1) @map("tenant_id")
  listId            BigInt       @map("list_id")
  ownerUserId       BigInt       @map("owner_user_id")
  status            ImportStatus @default(queued)
  sourceKey         String       @map("source_key") @db.VarChar(512)   // s3://bucket/key or local path
  errorsKey         String?      @map("errors_key") @db.VarChar(512)
  fileBytes         BigInt?      @map("file_bytes")
  rowCountTotal     Int?         @map("row_count_total")
  rowCountProcessed Int          @default(0) @map("row_count_processed")  // checkpoint high-water mark
  rowCountInserted  Int          @default(0) @map("row_count_inserted")
  rowCountSkipped   Int          @default(0) @map("row_count_skipped")
  rowCountErrored   Int          @default(0) @map("row_count_errored")
  meta              Json         // upload-time options (mapping, dnc_policy, tz_policy, delimiter, encoding, etc.)
  errorSummary      Json?        @map("error_summary")  // {byCode:{INVALID_PHONE:n,...}}
  startedAt         DateTime?    @map("started_at") @db.DateTime(6)
  completedAt       DateTime?    @map("completed_at") @db.DateTime(6)
  failedReason      String?      @map("failed_reason") @db.VarChar(255)
  errorLimit        Int          @default(10000) @map("error_limit")   // abort above this
  createdAt         DateTime     @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt         DateTime     @updatedAt @map("updated_at") @db.DateTime(6)

  tenant  Tenant       @relation(fields: [tenantId], references: [id])
  list    List         @relation(fields: [listId], references: [id])
  owner   User         @relation(fields: [ownerUserId], references: [id])
  errors  ImportError[]

  @@index([tenantId, status, createdAt], map: "idx_imports_t_status_created")
  @@index([tenantId, listId, createdAt], map: "idx_imports_t_list_created")
  @@map("imports")
}

enum ImportStatus { queued running done failed cancelled }
```

Retention: `imports` row 5 years (TCPA audit evidence). Original CSV file 30 days S3 lifecycle. C04 owns the sweep.

### 4.2 New table: `import_errors` (partitioned)

```prisma
model ImportError {
  id            BigInt   @default(autoincrement())
  tenantId      BigInt   @default(1) @map("tenant_id")
  importId      String   @map("import_id") @db.Char(26)
  sourceLine    Int      @map("source_line")      // info.lines from csv-parse
  sourceRecord  Int      @map("source_record")    // info.records (0-based)
  errorCode     String   @map("error_code") @db.VarChar(48)
  errorMsg      String?  @map("error_msg") @db.VarChar(512)
  rawRow        Json?    @map("raw_row")           // optional; capped 4 KB; default off
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(6)

  // Composite PK includes partition column per F02 partitioned-table convention:
  @@id([id, createdAt])
  @@index([tenantId, importId, sourceLine], map: "idx_import_errors_t_import_line")
  @@index([tenantId, importId, errorCode], map: "idx_import_errors_t_import_code")
  @@map("import_errors")
}
```

Partitioned monthly `RANGE COLUMNS(created_at)` — same convention as `call_window_audit`, `dnc_sync_log`, `originate_audit`. Immutability triggers: `_no_update`, `_no_delete` (append-only; partition rotation via DDL `DROP PARTITION` by C04). Retention: 90 days rolling (monthly partition drop).

### 4.3 New column: `lists.column_mapping`

```sql
ALTER TABLE lists ADD COLUMN column_mapping JSON NULL;
```

Holds the mapping JSON object (§5.1 mapping shape). Updated on every successful import once confirmed. Nullable — absence means no mapping saved yet. Snapshotted at import-start; schema changes mid-import are ignored for that run.

### 4.4 F02 coordination

These three additions are new items not in the current F02 AMENDMENTS-HANDOFF (which covers C01, D01, D05, E01, T02, T04). They ship as a single additive migration `20260507_d02_import_tables/`. Filed to orchestrator to batch with any other pending module amendments before D02 IMPLEMENT starts.

---

## 5. API surface (REST endpoints)

All routes mounted under `/api/admin`. All require `requireAuth` + `requireTenant` + `requirePermission('lead:import')` (F05). Tenant-scoped via F05 AsyncLocalStorage extension.

### 5.1 Endpoint table (FROZEN)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/admin/lists/:listId/imports` | Multipart upload; returns 202 + import_id |
| `GET` | `/api/admin/imports` | List recent imports for tenant; cursor-paginated |
| `GET` | `/api/admin/imports/:id` | Status JSON |
| `GET` | `/api/admin/imports/:id/events` | SSE progress stream (`text/event-stream`) |
| `GET` | `/api/admin/imports/:id/errors.csv` | Error report stream; `Content-Disposition: attachment` |
| `POST` | `/api/admin/lists/:listId/mapping/preview` | Preview mapping vs first 100 rows; no insert |
| `POST` | `/api/admin/imports/:id/cancel` | Phase 2 — sets cancel flag; 501 in Phase 1 |

Rate-limit (F04 Valkey store, keyed `(tenant_id, route)`):
- `POST /imports`: **5 rpm** per tenant (large file upload)
- `GET /imports/:id/events`: **30 rpm** (SSE reconnects)
- `POST .../mapping/preview`: **30 rpm**

### 5.2 Upload request shape

```
POST /api/admin/lists/:listId/imports
Content-Type: multipart/form-data; boundary=...

(part 1: name="file", filename="leads.csv")   <CSV bytes — streamed to S3/local>
(part 2: name="meta", Content-Type: application/json)
{
  "name": "Q2 2026 Florida cold list",
  "delimiter": "auto",
  "encoding": "auto",
  "header_row": true,
  "skip_rows": 0,
  "mapping": { ... } | "inherit",
  "dedup_policy": "skip_in_file" | "skip_cross_list" | "skip_tenant",
  "dnc_policy": "skip" | "mark" | "proceed",
  "tz_policy": "skip" | "mark" | "proceed",
  "default_country": "US",
  "default_status": "NEW",
  "options": {
    "lookup_state_from_zip": true,
    "legacy_backslash_escape": false,
    "strict_phone": true,
    "persist_raw_errors": false
  }
}
→ 202 Accepted
{
  "import_id": "01HZW...",
  "status": "queued",
  "estimated_rows": null
}
```

`@fastify/multipart@^9` in stream mode: `request.file()` → `{ file: Readable }` piped directly to `fs.createWriteStream(localPath)` (dev) or `@aws-sdk/lib-storage Upload` (prod). The HTTP request body never buffers to JS memory. Route-level `bodyTimeout: 1800000` (30 min) for slow uplinks. `Content-Length` validated against per-tenant `max_upload_bytes` (default 512 MB).

### 5.3 Status response shape

```json
{
  "import_id": "01HZW...",
  "status": "running",
  "started_at": "2026-05-13T14:00:00.000000Z",
  "completed_at": null,
  "row_count_total": 100000,
  "row_count_processed": 47800,
  "row_count_inserted": 45200,
  "row_count_skipped": 2200,
  "row_count_errored": 400,
  "summary": {
    "by_error_code": { "INVALID_PHONE": 320, "DNC_BLOCKED": 70, "DUPLICATE_IN_FILE": 10 }
  },
  "errors_url": "/api/admin/imports/01HZW.../errors.csv"
}
```

### 5.4 Preview endpoint

```
POST /api/admin/lists/:listId/mapping/preview
Body: { source_key: "s3://...", mapping: {...}, delimiter: "auto" }
→ 200
{
  "headers": ["Phone", "First Name", "Email", ...],
  "rows": [ { "Phone": "8005551234", ... } ],  // first 100 rows, raw
  "auto_detect": {
    "Phone": { "target": "phone_e164", "confidence": 0.9 },
    "First Name": { "target": "first_name", "confidence": 0.9 }
  },
  "mapping_applied": [ { "Phone": "+18005551234" }, ... ]  // first 100 rows after mapping+normalize
}
```

Streams first 100 rows only; no DB writes. Used by UI before confirming mapping.

---

## 6. Background worker pattern (BullMQ)

### 6.1 Queue topology (FROZEN)

```ts
// api side — POST /imports handler
const importQueue = new Queue('vici2:queue:lead-import', {
  connection: valkeyConn,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10000 },
    removeOnFail:    { age: 30 * 24 * 3600 },
  },
});
await importQueue.add('import', { importId, tenantId, listId }, { jobId: importId });

// worker side — workers/src/jobs/lead-import/worker.ts
new Worker('vici2:queue:lead-import',
  path.resolve(__dirname, 'processor.cjs'),    // sandboxed process
  {
    connection: valkeyConn,
    concurrency: 2,                              // per pod; saturates 4-vCPU box
    lockDuration: 60_000,                        // refreshed every 30 s via extendLock
    stalledInterval: 30_000,
  },
);
```

**Sandboxed processor**: `processor.cjs` is loaded via `new Worker(..., processorPath)` which spawns a separate Node process. If `csv-parse` throws a fatal error in the hot loop, only the child process exits; the parent worker respawns and BullMQ retries the job. No OOM in the parent.

### 6.2 Job lifecycle hooks

| Hook | Action |
|---|---|
| `onActive` | `UPDATE imports SET status='running', started_at=NOW(6)` |
| `onProgress` | No DB write (processor updates `row_count_*` directly per batch); BullMQ progress → SSE only |
| `onCompleted` | `UPDATE imports SET status='done', completed_at=NOW(6), error_summary=?` |
| `onFailed` (after final retry) | `UPDATE imports SET status='failed', failed_reason=substring(err.message,1,255)` |

### 6.3 Resume from checkpoint

On retry, processor reads `imports.row_count_processed` (high-water mark) and skips the first `Math.floor(row_count_processed / 500)` batches. Per-batch idempotency keys are stable (`ulid(importId + ':batch:' + batchIndex)`) so re-submitted batches hit D01's Valkey idem cache and return the cached response without re-inserting.

### 6.4 Cancellation (Phase 2)

`POST /api/admin/imports/:id/cancel` sets `imports.status='cancelled'` and `SET t:{tid}:import:{id}:cancel 1 EX 3600` in Valkey. Processor polls this key between batches. Already-inserted rows stay. Returns `501 Not Implemented` in Phase 1.

---

## 7. Column mapping and preview

### 7.1 Mapping shape (FROZEN wire format)

```jsonc
// lists.column_mapping / POST /imports body.mapping
{
  "version": 1,
  "rows": [
    { "source": "Phone",         "target": "phone_e164",    "transform": "phone" },
    { "source": "First Name",    "target": "first_name",    "transform": "trim" },
    { "source": "Email Address", "target": "email",         "transform": "lower" },
    { "source": "Birth Date",    "target": "date_of_birth", "transform": "date:MM/DD/YYYY" },
    { "source": "State",         "target": "state",         "transform": "trim,upper" },
    { "source": "Account #",     "target": "custom.acct_id","transform": "trim" }
  ],
  "options": {
    "default_status": "NEW",
    "default_country": "US",
    "lookup_state_from_zip": true,
    "skip_blank_rows": true
  }
}
```

**Target namespace:**
- Core columns: `phone_e164`, `phone_alt`, `phone_alt2`, `first_name`, `last_name`, `middle_initial`, `title`, `address1`, `address2`, `city`, `state`, `postal_code`, `country_code`, `email`, `date_of_birth`, `gender`, `comments`, `vendor_lead_code`, `source_id`, `rank`, `owner_user_id`, `entry_at`, `status`.
- Custom: `custom.<key>` (mapped to `leads.custom_data[key]`).

**Transform functions:** `phone`, `date:<format>` (date-fns parse), `lower`, `upper`, `trim`, `nullify_blank`, `concat:<col>`, `map:<k>=<v>;<k2>=<v2>`, `parseInt`, `parseFloat`.

**Vicidial preset:** `mapping: "vicidial_default"` triggers a built-in mapping matching `admin_listloader_third_gen.php` column names (`phone_number`, `first_name`, `last_name`, `state`, `postal_code`, `vendor_lead_code`, etc.).

### 7.2 Auto-detect heuristic (first upload)

```ts
const AUTO_DETECT_RULES = [
  { target: 'phone_e164',    match: /\b(phone|mobile|cell|tel|telephone|primary[_ ]?phone)\b/i },
  { target: 'phone_alt',     match: /\b(alt[_ ]?phone|secondary[_ ]?phone|phone[_ ]?2)\b/i },
  { target: 'first_name',    match: /\b(first[_ ]?name|fname|given[_ ]?name)\b/i },
  { target: 'last_name',     match: /\b(last[_ ]?name|lname|surname|family[_ ]?name)\b/i },
  { target: 'email',         match: /\bemail\b/i },
  { target: 'state',         match: /\bstate\b/i },
  { target: 'postal_code',   match: /\b(zip|postal[_ ]?code|postcode)\b/i },
  { target: 'date_of_birth', match: /\b(dob|birth[_ ]?date|date[_ ]?of[_ ]?birth)\b/i },
];
```

Confidence: substring match → 0.9; exact match → 1.0. UI renders confidence and allows drag-override. **Mapping must be confirmed by operator before processing starts** (D02.md risk mitigation).

### 7.3 Inherit mode

`mapping: "inherit"` reuses `lists.column_mapping`. CSV header validated case-insensitively against persisted mapping. Drift → `400 HEADER_MISMATCH` with diff of new vs expected headers. Operator must re-confirm mapping.

### 7.4 Column-mapping cache in worker

Worker snapshots `lists.column_mapping` at job-start (single read). Schema changes during the import run are ignored for that run (consistent validation throughout the file). Per-list Zod schema for `custom_data` uses D01's LRU cache (size 256, TTL 5 min) — same cache the REST handlers use.

---

## 8. Dedup layers

### 8.1 Within-file dedup (mandatory, always-on)

`Set<string>` of E.164 phones accumulated during the import. Second occurrence → errors-stream with `code: 'DUPLICATE_IN_FILE', _error_message: "Phone +1NXX already on line N of this file"`. Memory: 1 M × ~16 B ≈ 16 MB (acceptable; pre-calculated in §2.3).

Bloom filter rejected for this use case (FP rate 0.001 on 1 M rows → ~1 000 incorrectly-dropped rows = data loss; not acceptable).

### 8.2 Target-list dedup (enforced by F02 UNIQUE constraint)

F02 `UNIQUE(tenant_id, list_id, phone_e164)` on `leads` — D01's `createMany({skipDuplicates:true})` translates to MySQL `INSERT IGNORE`. Violations land in D01's `skipped` count, forwarded to `imports.row_count_skipped`. Error in errors.csv: `code: 'DUPLICATE_IN_LIST'` (informational — row was not inserted but is not a hard failure).

### 8.3 Tenant-wide cross-list dedup (configurable, default off)

`dedup_policy: 'skip_tenant'` — per batch of 500, run:
```sql
SELECT phone_e164 FROM leads
WHERE tenant_id = ? AND phone_e164 IN (?, ?, ...)
LIMIT 501
```
Uses `idx_t_phone` (F02 index on `(tenant_id, phone_e164)`). Phones found → errors-stream `code: 'DUPLICATE_IN_TENANT'`. ~10 ms per batch; within throughput budget.

### 8.4 Recycle-aware dedup (deferred to D06 / Phase 2)

Phone exists in tenant and was last called > campaign's `recycle_delay_seconds` threshold. Re-activate the existing lead instead of inserting. D06 owns recycle semantics; D02 Phase 1 skips this mode. Documented in HANDOFF.

---

## 9. DNC + TCPA integration

### 9.1 DNC scrub (D05 Bloom gate)

**Per batch of 100 phones** (optimal pipeline size for Bloom MEXISTS):
1. Build pipeline: `BF.MEXISTS bf:dnc:federal {phone}` + `t:{tid}:dnc:state:bloom` + `t:{tid}:dnc:internal:bloom` — one round-trip.
2. For each positive Bloom hit, run D05 MySQL confirm (`SELECT source FROM dnc WHERE phone_e164=? AND tenant_id IN (?,0) AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 3`).
3. Apply `dnc_policy`:
   - `skip` (default) — exclude from batch → errors-stream `code:'DNC_BLOCKED', _error_message:"<source> DNC"`.
   - `mark` — include with `status='DNC'` → informational warning in errors.csv `code:'DNC_WARN'`.
   - `proceed` — include normally → warning line in errors.csv `code:'DNC_WARN'`.

**DNC Bloom unavailable**: per D05 PLAN §1.5, fall back to MySQL-only confirm. If MySQL also unreachable — abort the import with `DB_TRANSIENT` (do not fail-closed mark entire file as DNC). Operator notified via `import.failed` audit event + SSE.

**DNC bypass for imports is not exposed.** Operators who legitimately need to import known-DNC numbers must do it lead-by-lead via D01 with explicit `super_admin` audit trail.

### 9.2 TCPA timezone policy (D03 cascade)

**Per row** (not per batch — D03 resolve is a hashmap lookup, sub-microsecond after warm cache):
1. Call D03 `tz.Resolve(phone, zip, state)` → `{ iana, confidence, source }`.
2. Apply `tz_policy`:
   - `skip` — if confidence == NONE, exclude row → errors-stream `code:'NO_TIMEZONE'`.
   - `mark` (default) — if confidence == NONE, include with `leads.tz_blocked=true` → informational `code:'TZ_BLOCKED_WARN'` in errors.csv. C01 at dial time is authoritative.
   - `proceed` — include normally regardless of confidence.

D02 does **not** call `C01.Check()` at import time. The import-time TZ gate is advisory only (sets `tz_blocked` for M03 admin review). The authoritative TCPA gate runs in E01 hopper filler and T04 originate path.

### 9.3 Pre-processing preview (stretch goal, Phase 1 minimum = post-hoc errors.csv)

Before processing starts (after mapping confirmation), UI can request a preview via `POST .../mapping/preview` which streams 100 rows through Stage 1–6 (including DNC + TZ scrub) without writing to DB. Response shows "7 will be DNC-blocked, 3 will be TZ-blocked" so operator can decide before committing a 200 k-row import. Phase 1 minimum: report errors after the fact in errors.csv.

---

## 10. Error reporting

### 10.1 Errors CSV shape (FROZEN)

```csv
_source_line,_source_record,_error_code,_error_message,<original CSV columns...>
17,16,INVALID_PHONE,"E.164 parse failed: empty string","","Bob","Smith","","","FL","",""
42,41,DUPLICATE_IN_FILE,"Phone +14155551234 already on line 9","+14155551234","Alice","Lee",...
99,98,DNC_BLOCKED,"federal DNC","+12025551234","",...
```

- `_source_line`: CSV physical starting line number (from `csv-parse info.lines`).
- `_source_record`: logical record number (0-based, from `info.records`).
- Original columns preserved verbatim (before transforms) so operator can fix-and-re-upload.
- Generated via `csv-stringify@^6` streaming (sibling of csv-parse; same author, compatible API).

### 10.2 Error code vocabulary (FROZEN — 18 codes)

| Code | Meaning | Level |
|---|---|---|
| `INVALID_PHONE` | libphonenumber-js parse/validate failed | row |
| `MISSING_REQUIRED_FIELD` | phone_e164 null or empty | row |
| `FIELD_COUNT_MISMATCH` | row has wrong # of fields vs header | row |
| `CUSTOM_DATA_SCHEMA_FAIL` | per-list Zod schema rejected custom_data | row |
| `INVALID_STATE` | not a US two-letter code; ZIP lookup also failed | row |
| `INVALID_DATE` | date_of_birth parse failed | row |
| `DUPLICATE_IN_FILE` | phone seen earlier in this file | row |
| `DUPLICATE_IN_LIST` | phone exists in target list (INSERT IGNORE — informational) | row |
| `DUPLICATE_IN_TENANT` | phone exists in other list in tenant (tenant_wide mode) | row |
| `DNC_BLOCKED` | DNC scrub matched (hard block per dnc_policy:skip) | row |
| `DNC_WARN` | DNC scrub matched but dnc_policy:mark or proceed | row |
| `NO_TIMEZONE` | D03 returned NONE confidence and tz_policy:skip | row |
| `TZ_BLOCKED_WARN` | tz_policy:mark — row written with tz_blocked=true | row |
| `MAX_RECORD_SIZE_EXCEEDED` | single row exceeded 1 MB (csv-parse limit) | row |
| `HEADER_MISMATCH` | inherit-mode header doesn't match persisted mapping | file |
| `UNSUPPORTED_ENCODING` | chardet returned unsupported encoding | file |
| `MAX_ERRORS_EXCEEDED` | errors exceeded `imports.error_limit` (default 10 000) — import aborted | file |
| `DB_TRANSIENT` | DB error after 3 retries | batch |

A unit test asserts the code set is exhaustive (no string outside this vocabulary ever appears in errors.csv). Adding a new code requires PR + vocabulary constant update.

### 10.3 Why CSV (not JSONL)

Operator workflow: open in Excel → fix cells → save as CSV → re-upload. JSONL would require a JSON-to-CSV round-trip. Streaming-writable row-by-row without buffering. Same delimiter/encoding as the source file makes re-upload natural.

### 10.4 `import_errors` table

Structured storage of error rows, enabled per-import via `meta.options.persist_raw_errors=true` (default off). `rawRow JSON` capped at 4 KB per row (truncated if wider). Purpose: disaster recovery when S3 errors.csv is inaccessible. C04 retention worker drops partitions older than 90 days.

---

## 11. Progress streaming (SSE)

### 11.1 SSE event stream

```
GET /api/admin/imports/:id/events
Accept: text/event-stream

event: progress
data: {"processed":47800,"total":100000,"inserted":45200,"skipped":2200,"errored":400}

event: progress
data: {"processed":100000,"total":100000,"inserted":96000,"skipped":3500,"errored":500}

event: done
data: {"status":"done","completed_at":"2026-05-13T14:17:23.000000Z","import_id":"01HZW..."}

event: failed
data: {"status":"failed","reason":"DB connection lost after 3 retries","import_id":"01HZW..."}
```

- **Heartbeat:** `data: \n\n` every 15 s — prevents NGINX (default 60 s timeout) and CDN proxy buffer stalls.
- **Reconnection:** `Last-Event-ID` maps to BullMQ job progress sequence; server resumes from last seen event via Valkey `XREAD jobs:vici2:queue:lead-import:events` stream offset.
- **Compression disabled** per-route for SSE endpoint (`@fastify/compress` must be disabled per-route; chunked transfer encoding is sufficient).

### 11.2 Worker → SSE path

```
processor.cjs  →  job.updateProgress({...})  →  BullMQ progress event
       →  Valkey pub/sub channel 'bull:vici2:queue:lead-import:events'
       →  API Fastify SSE handler subscribes  →  response.raw.write('event:progress\ndata:...\n\n')
```

Update cadence: every 1 000 rows (one progress event per 2 batches of 500). At 1 000 rows/sec, ~1 event/second — appropriate for a live progress bar.

### 11.3 Polling fallback

`GET /api/admin/imports/:id` returns current `row_count_*` counters (updated by processor after each batch via direct Prisma write). Clients without EventSource support poll at 5-second intervals. UI detects `EventSource` unavailability and falls back automatically.

---

## 12. Performance targets (FROZEN; CI-enforced)

### 12.1 Acceptance targets

| Metric | Target | Ceiling | How enforced |
|---|---:|---:|---|
| Heap during 1 M-row import | **< 200 MB** | 250 MB | `bench/D02/memory.bench.ts`; `--max-old-space-size=256`; CI fails on heap > 250 MB |
| Throughput Phase 1 (sustained) | **≥ 1 000 rows/sec** | — | `bench/D02/throughput.bench.ts`; 100 k synthetic rows |
| Throughput stretch goal | **≥ 5 000 rows/sec** | — | raw-INSERT fallback path (D01 PLAN §4.4); opt-in flag |
| 10 k-row CSV completion | **≤ 30 s** | 60 s | integration test (E2E) |
| UI progress visible | **within 1 s** of worker start | 5 s | SSE first event latency test |
| Error fidelity | **100%** per-row line numbers + codes | — | `bench/D02/error-fidelity.bench.ts` |

### 12.2 Throughput levers

1. **Primary path:** D01 `LeadService.bulkInsert` with Prisma `createMany`. p95 ≤ 1.5 s for 500 rows → ~333 rows/sec. Satisfies Phase 1 acceptance (1 000 rows/sec = 3 parallel batches).
2. **Raw-INSERT fallback:** `INSERT INTO leads (col1, col2, ...) VALUES (?,?,...),(?,?,...) ...` via `prisma.$executeRawUnsafe`. ~5× faster than Prisma `createMany` (Prisma issue #23791). Enabled per-import via `meta.options.raw_insert=true` or via worker env var `D02_USE_RAW_INSERT=true`. Ships Phase 1; not default (Prisma path preferred for audit/error integration; raw path lacks automatic skipDuplicates — must prepend `INSERT IGNORE`).
3. **Parallel batch flush (Phase 2):** 2-3 concurrent `bulkInsert` calls per worker; requires tracking per-batch CSV-line offsets for correct error row reporting.

### 12.3 Bottleneck confirmation in VERIFY

- Profile `process.memoryUsage()` at 100-batch intervals; log to structured log.
- Assert `EXPLAIN SELECT` on cross-list dedup query uses `idx_t_phone`.
- Measure BullMQ `job.updateProgress` RTT (should be < 5 ms per update).
- `prisma:query` log inspection during 100 k-row benchmark to confirm no N+1.

---

## 13. Files to create

### 13.1 TypeScript (api + workers)

```
api/src/import/
  index.ts                        — Fastify plugin; route registration + rate-limit config
  handlers/
    create.ts                     — POST /api/admin/lists/:listId/imports
    get.ts                        — GET /api/admin/imports/:id
    list.ts                       — GET /api/admin/imports (cursor-paginated)
    events.ts                     — GET /api/admin/imports/:id/events (SSE)
    errors-csv.ts                 — GET /api/admin/imports/:id/errors.csv
    preview.ts                    — POST /api/admin/lists/:listId/mapping/preview
    cancel.ts                     — POST /api/admin/imports/:id/cancel (Phase 2 stub)
  schemas.ts                      — Zod input/output schemas; exported
  storage.ts                      — S3/local upload/download abstraction
  sse.ts                          — Fastify SSE helper (heartbeat, reconnect via Last-Event-ID)
  mapping/
    auto-detect.ts                — AUTO_DETECT_RULES heuristic
    apply.ts                      — source→target remap + transform functions
    validate.ts                   — mapping JSON Zod schema; version check

workers/src/jobs/lead-import/
  worker.ts                       — BullMQ Worker constructor + lifecycle hooks
  processor.ts                    — compiled to processor.cjs (sandboxed); hot loop
  pipeline/
    encoding-detect.ts            — chardet + iconv-lite Transform
    csv-parser.ts                 — csv-parse Transform factory (options pinned)
    apply-mapping.ts              — Stage 3 Transform (wraps mapping/apply.ts)
    normalize-validate.ts         — Stage 4 Transform (libphonenumber, Zod, state/date)
    in-file-dedup.ts              — Stage 5 Transform (Set<string>)
    dnc-tcpa-scrub.ts             — Stage 6 Transform (D05 Bloom + D03 tz.Resolve)
    batcher.ts                    — Stage 7 Transform (accumulate 500, emit array)
    db-writer.ts                  — Writable (LeadService.bulkInsert + progress update)
    errors-stream.ts              — PassThrough → csv-stringify Writable → S3/local
  types.ts                        — ImportJob payload type; PipelineRow type
  error-codes.ts                  — FROZEN vocabulary const + exhaustiveness test hook

shared/types/src/
  import.ts                       — Import, ImportStatus, ImportError Zod schemas
  import-mapping.ts               — ColumnMapping Zod schema

api/test/import/
  schemas.test.ts                 — Zod round-trips
  mapping/
    auto-detect.test.ts           — header heuristic coverage
    apply.test.ts                 — transform functions
  handlers/
    create.test.ts                — upload → 202; reject oversized; multipart validation
    get.test.ts                   — status shape; 404 cross-tenant
    list.test.ts                  — cursor pagination
    events.test.ts                — SSE heartbeat; done/failed events
    errors-csv.test.ts            — content-disposition; CSV shape
    preview.test.ts               — first 100 rows; mapping applied
  pipeline/
    encoding-detect.test.ts       — UTF-8/16/windows-1252 round-trips
    csv-parser.test.ts            — embedded newlines; field-count mismatch; BOM strip
    normalize-validate.test.ts    — phone edge cases; state derive from ZIP
    in-file-dedup.test.ts         — second occurrence; 1 M-row Set size
    dnc-tcpa-scrub.test.ts        — mock D05 Bloom; skip/mark/proceed policies
    batcher.test.ts               — batch boundary; partial last batch
    db-writer.test.ts             — idempotency key derivation; progress update
  integration/
    e2e-import.test.ts            — 10 k row CSV end-to-end < 30 s
    tenant-isolation.test.ts      — cross-tenant import status → 404
    sse-progress.test.ts          — EventSource reconnect via Last-Event-ID
    error-fidelity.test.ts        — 7 injected bad rows in 1 000-row file
  bench/
    throughput.bench.ts           — 100 k synthetic rows; ≥ 1 000 rows/sec
    memory.bench.ts               — 1 M synthetic rows; heap < 250 MB
    error-fidelity.bench.ts       — 7 bad rows in 1 000; all 7 in errors.csv with correct line#

api/prisma/migrations/20260507_d02_import_tables/
  migration.sql                   — CREATE TABLE imports; CREATE TABLE import_errors (partitioned);
                                    ALTER TABLE lists ADD COLUMN column_mapping JSON NULL;
                                    immutability triggers for import_errors
```

---

## 14. Test plan

### 14.1 Unit tests (vitest)

- **Schemas**: Zod round-trips for `Import`, `ImportError`, `ColumnMapping` (version check, invalid target namespace, transform validation).
- **Auto-detect**: all `AUTO_DETECT_RULES` match; confidence ordering; no false positives on unrelated headers.
- **Transform functions**: `phone` (E.164 normalization), `date:<fmt>` (date-fns), `lower/upper/trim`, `nullify_blank`, `map:k=v`, `concat:<col>`.
- **Error codes**: exhaustiveness assertion — a static set check prevents code outside `error-codes.ts` from appearing in output.
- **In-file dedup**: second occurrence → `DUPLICATE_IN_FILE`; 1 M-entry Set stays under 20 MB.
- **csv-parser**: embedded-newline records, BOM strip (UTF-8 and UTF-16LE), field-count mismatch, `max_record_size` rejection.
- **Encoding detect**: UTF-8/BOM pass-through, UTF-16LE BOM redirect, UTF-16BE BOM redirect, windows-1252 chardet branch, unknown encoding `400`.

### 14.2 Integration tests (vitest + testcontainers)

- Real MySQL 8 + Valkey + MinIO via docker-compose (F01 stack).
- **E2E import**: upload 10 k-row synthetic CSV → job queued → worker processes → `imports.status='done'` within 30 s → `imports.row_count_inserted` matches valid row count.
- **Tenant isolation**: attempt `GET /api/admin/imports/:id` for import owned by tenant B from tenant A session → `404 NOT_FOUND`.
- **SSE progress**: EventSource reconnects with `Last-Event-ID`; server resumes from correct offset (no duplicate events, no missing events).
- **Error fidelity**: inject 7 bad rows (2 `INVALID_PHONE`, 2 `DNC_BLOCKED`, 1 `FIELD_COUNT_MISMATCH`, 1 `INVALID_STATE`, 1 `DUPLICATE_IN_FILE`) in a 1 000-row file; assert errors.csv contains all 7 with correct `_source_line` values.
- **DNC policy modes**: mock D05 Bloom returning positive for rows 1, 50, 100 of a 100-row file; assert `skip` drops them from DB, `mark` inserts them with `status='DNC'`, `proceed` inserts normally and notes in errors.csv.
- **TZ policy modes**: mock D03 returning NONE confidence for rows 5, 6; assert `skip` drops them, `mark` sets `tz_blocked=true`, `proceed` inserts normally.
- **Idempotency**: submit same import twice (simulate retry); assert no duplicate leads inserted (D01 idempotency key cache hit).
- **Resume from checkpoint**: simulate crash after batch 3 of 20; `imports.row_count_processed` = 1500; re-submit with `?resume=true`; assert batches 1-3 are skipped (idem cache) and import completes correctly.
- **Memory (smoke)**: 100 k synthetic rows with `--max-old-space-size=256`; test passes if no OOM.
- **Audit trail**: every import queued/started/completed/failed writes corresponding `audit_events` rows via F05 audit() helper.
- **Column mapping inherit**: first upload saves mapping; second upload with `mapping:"inherit"` and same headers proceeds; second upload with drifted headers returns `400 HEADER_MISMATCH`.

### 14.3 Performance (bench, run pre-release)

- `bench/D02/throughput.bench.ts`: 100 k rows, p50 ≥ 1 000 rows/sec, CI gate.
- `bench/D02/memory.bench.ts`: 1 M rows, heap < 250 MB at any point (checked every 100 batches), CI gate.
- `bench/D02/error-fidelity.bench.ts`: 7 bad rows in 1 000, all 7 in errors.csv with exact line numbers, CI gate.

### 14.4 Security

- Upload path rejects files with `path traversal` in the multipart filename.
- Tenant isolation: cross-tenant access to import status/errors → 404 (not 403; don't leak existence).
- `meta.options.persist_raw_errors=true` with a `rawRow` containing `phone_e164` and `email` — CI grep ensures these don't appear in Pino log lines (F05 §9.3 no-secrets rule extended to import handler).
- File size cap enforced before streaming to S3 (per-tenant `max_upload_bytes`).
- `HEADER_MISMATCH` diffing does not leak tenant B's column names to tenant A (cross-tenant mapping inherit blocked at RBAC).

### 14.5 Coverage targets

- `api/src/import/**`: ≥ 70% line coverage (SPEC §3.10 baseline).
- `workers/src/jobs/lead-import/pipeline/**`: ≥ 80% line coverage (correctness-critical hot loop).
- `error-codes.ts` exhaustiveness assertion: 100% (it's a static check).

---

## 15. Acceptance criteria

- [ ] **Memory bounded**: 1 M-row CSV import heap ≤ 200 MB throughout. Verified by `bench/D02/memory.bench.ts` with `--max-old-space-size=256`.
- [ ] **Throughput**: ≥ 1 000 rows/sec sustained on Phase 1 hardware. Verified by `bench/D02/throughput.bench.ts`.
- [ ] **Per-row error fidelity**: every error row in errors.csv has `_source_line` (csv-parse `info.lines`), `_source_record`, stable `_error_code`, human `_error_message`, and original row columns. Verified by `bench/D02/error-fidelity.bench.ts`.
- [ ] **Header mapping persisted per list**: `lists.column_mapping` updated after first successful import; reused on subsequent uploads with `mapping:'inherit'`. Verified by integration test.
- [ ] **DNC scrub on import**: federal, state, and internal Bloom gates consulted per batch of 100 phones; `dnc_policy` applied correctly (`skip`, `mark`, `proceed`). Verified by integration test with mocked D05 Bloom.
- [ ] **TCPA tz derivation**: D03 `tz.Resolve()` called per row; `tz_policy:'mark'` sets `leads.tz_blocked=true`. Verified by integration test with mocked D03.
- [ ] **Job retried ≤ 3×** on transient failure; resume from `imports.row_count_processed` checkpoint without double-inserting. Verified by integration test simulating crash mid-import.
- [ ] **UI progress visible within 1 s** of worker start via SSE. Verified by SSE latency integration test.
- [ ] **10 k-row CSV ≤ 30 s** end-to-end (upload + process + done). Verified by E2E integration test.
- [ ] **Idempotent re-upload**: same CSV same `import_id` → no duplicate leads in DB. Verified by idempotency integration test.
- [ ] **Schema migrations**: `imports`, `import_errors` (partitioned), `lists.column_mapping` created cleanly by `prisma migrate deploy` on fresh DB.
- [ ] **Audit trail**: `import.queued`, `import.started`, `import.completed`, `import.failed` events written to `audit_events` via F05 audit() helper.
- [ ] **Error code vocabulary frozen**: unit test asserts no string outside `error-codes.ts` const set appears in errors.csv output.
- [ ] **HANDOFF.md** ships with: raw-INSERT fallback runbook, Phase 1.5 XLSX implementation guide, Phase 2 parallel-shard plan, D06 recycle-aware dedup escape hatch, per-tenant upload byte cap configuration.

---

## 16. Dependencies

### 16.1 Blocking dependencies (must be done before D02 IMPLEMENT)

| Module | What D02 needs | Status |
|---|---|---|
| **D01 PLAN** | `LeadService.bulkInsert` contract (batch shape, idempotency key, audit context tag, error shape) | PLAN LANDED |
| **D05 PLAN** | D05 Bloom MEXISTS pipeline contract; `Check()` API shape; fail-closed behavior on Bloom unavailable | PLAN LANDED |
| **C01 PLAN** | `leads.tz_blocked` column (already in F02 AMENDMENTS-HANDOFF); D03 `tz.Resolve()` confidence enum values | PLAN LANDED |
| **F02 AMENDMENTS-HANDOFF** | `leads.tz_blocked` (C01.4), `leads.version` (D01.1) already shipped; `imports` + `import_errors` + `lists.column_mapping` need one more additive migration | LANDED (amendments needed) |
| **F04 PLAN** | BullMQ over Valkey queue `vici2:queue:lead-import`; Valkey pub/sub for SSE | PLAN |
| **F05 PLAN** | `requirePermission('lead:import')` RBAC; AsyncLocalStorage tenant extension; audit() helper | PLAN |

### 16.2 Downstream modules unblocked by D02

| Module | What it gains |
|---|---|
| **M03** | Admin import UI can render progress, mapping form, errors.csv download, and list of recent imports |
| **N01** (Phase 4) | External bulk add-lead reuses `LeadService.bulkInsert` and column-mapping infrastructure |
| **C04** | `import_errors` partitioned table added to C04's rotation catalog; `imports` rows added to 5-year retention sweep |

---

## 17. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Memory leak in `csv-parse` stream on malformed CSV | Low | High | Pinned `^5.5.0`; `bench/D02/memory.bench.ts` CI gate; `max_record_size:1MB` caps pathological rows |
| Header auto-detect wrong → wrong-column data inserted | Medium | High | Mapping confirmation mandatory before processing; preview endpoint shows first 100 rows with mapping applied; operator cannot skip confirm |
| DNC Bloom unavailable → abort import (not fail-closed mark all DNC) | Low | Medium | Abort with `DB_TRANSIENT` + operator alert; operator re-submits after Bloom restore; per D05 §1.5 fallback to MySQL-only if Bloom down |
| D01 `bulkInsert` 1.5 s p95 budget slipped → throughput miss | Medium | Medium | Raw-INSERT fallback (D01 PLAN §4.4) ships Phase 1 as opt-in; CI perf gate catches regression |
| Worker pod crashes mid-import | Medium | Medium | BullMQ `attempts:3` + sandboxed processor; resume from `row_count_processed` checkpoint |
| Operator uploads 10 GB file via slow network → multipart timeout | Medium | Low | `bodyTimeout: 1800000` (30 min); streaming to S3 — no JS memory buffering |
| Idempotency key collision (same key, different content) | Low | High | Key = `ulid(importId + ':batch:' + batchIndex)`; `importId` is ULID (globally unique); different import = different `importId` = different keys |
| Errors CSV grows unbounded for pathologically bad file | Low | Low | Cap at `imports.error_limit` (default 10 000) → abort with `MAX_ERRORS_EXCEEDED` |
| `lists.column_mapping` schema changes mid-import | Low | Low | Snapshot at job-start; ignore changes during run; consistent validation throughout file |
| S3 unavailable during errors.csv write | Low | Low | `meta.options.persist_raw_errors=true` persists structured errors in `import_errors` table; operator re-downloads when S3 restored |
| Vicidial-format CSV column names unrecognized | Medium | Low | Ship `mapping:'vicidial_default'` preset matching third/fourth-gen listloader column names |
| F02 amendment for `imports` tables delayed | Medium | Medium | D02 IMPLEMENT blocked until migration lands; coordinated at orchestrator level |
| Concurrent scrub calls spike Valkey (2 workers × 100 phones × batch = 200 concurrent pipeline calls) | Low | Low | BullMQ concurrency=2 is the design; Valkey pipeline is < 1 ms per 100-phone batch; well within Valkey capacity |

---

## 18. Open questions resolved

All 13 RESEARCH §16 open questions resolved by this PLAN:

| # | Question | Resolution |
|---|---|---|
| 1 | `csv-parse` vs `papaparse` | **`csv-parse@^5.5.0`** — native Transform, `info` option for line numbers, `csv-stringify` sibling |
| 2 | XLSX Phase 1 or 1.5? | **Phase 1.5** — `exceljs@^4 WorkbookReader`; operators save as CSV |
| 3 | Error format | **CSV** — operator fix-and-re-upload workflow |
| 4 | D01 calling convention | **Direct service import** — no HTTP overhead, no rate-limit, same audit path |
| 5 | Checkpoint granularity | **Per-batch (500 rows)** — row-level adds 17 min overhead on 1 M rows |
| 6 | Original-CSV retention | **30 days** S3 lifecycle |
| 7 | UI live-progress mechanism | **SSE** with 5 s polling fallback |
| 8 | DNC default policy | **`skip`** — industry consensus; fail-safe |
| 9 | TZ default policy | **`mark`** — sets `tz_blocked=true`; C01 at dial time is authoritative |
| 10 | In-file dedup data structure | **`Set<string>`** — no FP data loss; 16 MB cost acceptable |
| 11 | Persist raw-row in `import_errors`? | **Default off** — opt-in `meta.options.persist_raw_errors=true`; capped 4 KB |
| 12 | Auto-detect delimiter scope | **First 4 KB** |
| 13 | Recycle-aware dedup | **Defer to D06 / Phase 2** |

---

End of PLAN.md.
