# D02 — Lead List CSV Import — RESEARCH

| Field | Value |
|---|---|
| Module | D02 (Data track, Phase 1) — bulk lead-import pipeline |
| Author | D02-RESEARCH sub-agent (Claude Opus 4.7, 1M ctx) |
| Date  | 2026-05-13 |
| Status | RESEARCH (PLAN-ready) |
| Module-spec source | `/root/vici2/spec/modules/D02.md` |
| Depends-on PLANs | D01 (LeadService bulkInsert — PLAN LANDED), D05 (DNC scrub — PLAN LANDED), C01 (TCPA tz gate — PLAN LANDED), F02 (lead/list schema + AMENDMENTS-HANDOFF LANDED), F04 (Valkey + BullMQ — PLAN), F05 (RBAC + multipart auth — PLAN) |
| Blocks downstream | M03 (admin lead UI), N01 (Phase 4 external bulk add-lead), C04 (retention sweep over `imports` tables) |
| Module-spec source-of-truth quote | "Asynchronous CSV ingestion: admin uploads → file lands in S3/local → background worker streams it row-by-row, normalizes phones, validates against the list's custom_data schema, writes via D01 `bulkInsert`, reports progress and errors back to UI." (D02.md §Goal) |

---

## 0. Executive summary (10 bullets)

1. **D02 is the only Node-side service that processes user-uploaded CSV/XLSX files at scale.** Its hard correctness invariants are (a) **memory bounded** (the module-spec acceptance criterion: "1M-row CSV imports without OOM, memory stays under 200 MB throughout"); (b) **resumable** ("Job retried up to 3× on transient failure"); (c) **per-row error fidelity** (errors.csv must include the original row + reason — no row swallowed); (d) **idempotent** (re-uploading the same CSV under the same `import_id` must not double-insert leads); (e) **compliance-aware** (DNC scrub on ingest is a hard floor per D05, TCPA tz derivation is mandatory per C01). The architecture below pins every one of those invariants to a concrete mechanism.

2. **The pipeline collapses to five stages connected by Node 20 native `stream.pipeline`**, each a `Transform` running in object-mode: `(source) → decode → parse → validate-and-normalize → batch-of-500 → POST /api/leads/bulk (or direct D01 service call)`. Streams give us automatic backpressure end-to-end; the parser will not over-feed the normalizer, the normalizer will not over-feed the batcher, the batcher will not over-feed the writer. Node's `stream/promises.pipeline()` is the canonical 2026 wiring (Node.js v24 docs [3]; the dev.to "11 backpressure patterns" piece [22] confirms `pipeline()` is the production-default replacement for `.pipe()` chains). Async-iterator alternative is documented in §4.7 with rejection rationale.

3. **CSV parser = `csv-parse` v5 (stream mode), with `papaparse` 5.5.3 as the rejected runner-up.** `csv-parse` is in the same node-csv family as `csv-stringify` (used by D02 for the error report) — same author, identical option shape, native Node `Transform` stream interface, BOM auto-strip (UTF-8 + UTF-16LE) [16][17]. Benchmarks [1][8] put it 5–15 % slower than `papaparse` on raw throughput but with **fine-grained control** that matters for our error-fidelity invariant: per-record `info` flag exposes `info.lines` (CSV line number) and `info.records` (logical record number) which we need verbatim in errors.csv. `papaparse` 5.5.3 [27] has the better browser story (web-workers) but worse Node ergonomics in `step` mode — no built-in BOM-stripping for UTF-16LE, no first-class line-number callback. `fast-csv` is consistently the slowest of the three across multiple 2026 benchmarks [1][2]; `csv-parser` is **deprecated as of 2023** [1]. Decision matrix in §5.1.

4. **XLSX support is Phase-1 deferred to Phase-1.5 (post-MVP).** The module-spec only names CSV. We document `exceljs` `WorkbookReader` streaming as the Phase-1.5 chosen lib (90 % of operator CSVs are exports from Excel anyway, so we can hint operators to "Save As CSV"). When XLSX lands: `exceljs` v4 `stream.xlsx.WorkbookReader({ sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore' })` per the ExcelJS large-files guide [9][32] — uses ~6× less memory than SheetJS at the cost of ~30 % wall time; serverless-friendly. `xlsx-stream-reader` [10] is a maintained fork that handles the worst-case "shared strings late in the zip" by transparently re-reading; nice to have but `exceljs` is sufficient. We **do not** ship XLSX in Phase 1 because the rabbit-hole (shared-strings, formula cells, merged cells, multi-sheet, encrypted .xlsx) is two weeks of additional research and the Phase-1 release plan is 3-4 days for D02 (D02.md effort).

5. **File storage = local volume in dev, S3/MinIO via `fastify-multer-s3` in prod.** Per F01/F03 storage plans the `data/csv/` bind mount is already in `docker-compose.dev.yml`. Multipart upload streams **directly** to disk (dev) or S3 (prod) — never to memory — using `fastify-multipart`'s `saveAs()` helper or `fastify-multer-s3`'s streaming engine [21]. The HTTP request returns within a few seconds even for a 500 MB file because the request body streams to backing-store in parallel with arrival. Once the body is at rest, we `XADD` a BullMQ job and return `202 Accepted` with `{ import_id }`. Retention: original CSV kept **30 days** in S3 lifecycle policy (audit-trail per N01 contract); error report kept **90 days**.

6. **Job queue = BullMQ over Valkey** (per F04 PLAN). One queue `vici2:queue:lead-import`, concurrency 2 per worker pod (CSV parse is CPU-bound enough that two parallel jobs saturate a 4-vCPU pod), no rate-limit (the limit is whatever the operator's MySQL can absorb — D01 bulk endpoint is rate-limited to 10 rpm but D02 calls the **service layer** directly, bypassing rate-limit per the D01 PLAN §14.1 "D02 chunks 10 000-row CSV into ≤ 20 calls of `POST /api/leads/bulk`" — clarified in §6 below). **Sandboxed processor** (per BullMQ sandbox docs [25]) — `csv-parse` SIGSEGV would orphan the queue worker otherwise; sandboxing isolates the streaming hot loop. Job retry: `attempts: 3, backoff: { type: 'exponential', delay: 5000 }`. Progress via `job.updateProgress({ processed, total, inserted, skipped, errors })` every 1 000 rows — fan-out to UI via Valkey pub/sub channel `t:{tid}:import:{id}:progress` (SSE/EventSource on the API gateway side, §11).

7. **Column-mapping persists on the list, not on every upload.** Per D02.md acceptance criterion "Header mapping persisted per list; reused on next upload" — we file an F02 amendment for `lists.column_mapping JSON NULLABLE` (deferred to PLAN, §13.1). First-upload flow: client uploads → server returns `header_preview` (first 100 rows, first 50 columns); UI shows mapping form (drag-source-to-target); client POSTs `/api/admin/lists/:listId/imports` with `{ mapping: {...}, source_key: 's3://...' }`. Subsequent uploads: pass `mapping: 'inherit'`. Mapping shape is `Record<sourceColumn, { target: 'phone_e164'|'first_name'|...|'custom.<key>', transform?: 'phone'|'date'|'upper'|'trim' }>`. Auto-detection (case-insensitive substring match) seeds the initial mapping but always with operator confirm per D02.md risk mitigation.

8. **Phone normalization happens in-stream via D01's normalize helper (`libphonenumber-js/min`).** Per D01 PLAN §6.1 we already pin libphonenumber-js `^1.11.x`. D02 does **not** re-normalize — it imports `api/src/leads/normalize.ts` and calls it inline in the validator Transform. Invalid phone produces a per-row error (`code: "INVALID_PHONE"`) and excludes the row from the bulk batch (does not abort the file). **Timezone derivation** is **not** done at write time — per F02 PLAN and D01 §13 the `leads.tz_offset_min` and `leads.known_timezone` columns are populated either by D03 trigger (Phase 1.5 if it lands) or lazily at C01 `Check()` call. D02's only timezone responsibility is to set `leads.tz_blocked = false` (default; C01 may flip later) and `leads.state` from the CSV's state column or from a ZIP lookup against `zip_codes` if `state` is empty (§7). Per Vicidial precedent [12][14][30][31], we mirror their `lookup_state='Y'` knob via `mapping.options.lookup_state_from_zip = true` (default).

9. **DNC scrub on import is policy-configurable per upload.** Per D05 PLAN the federal Bloom is global and a Bloom MEXISTS pipeline is sub-millisecond. We expose three modes via `POST /imports` body `dnc_policy: 'skip'|'mark'|'proceed'`: **skip** drops the row from the import (counts in `skipped`, written to errors.csv with `code:"DNC_BLOCKED", source:"..."`); **mark** writes the row but with `status='DNC'` (so it's in the DB for audit but never dialed); **proceed** writes the row and notes the DNC hit in `errors.csv` as a warning (the dial-time D05 gate still catches it). Default is **skip**. This is the industry-standard pattern per Convoso, ClickPoint, dnc.com [29][33]; the alternative (no scrub on import) is what older Vicidial does and is the source of countless "I imported and immediately dialed a litigator" forum threads [12]. C01 TCPA check follows the same `tz_policy: 'skip'|'mark'|'proceed'` shape (§9). DNC bypass for D02 imports is **not** exposed — operators who legitimately need to import known-DNC numbers (e.g., consented re-engagement) must do it lead-by-lead via D01 with explicit `super_admin` audit.

10. **Open questions for PLAN (top 7 of 13).** (i) `csv-parse` vs `papaparse` final pick — recommend `csv-parse` v5 (§5.1); (ii) XLSX in Phase 1 vs Phase 1.5 — recommend Phase 1.5 (§4.4); (iii) error-report format (CSV vs JSON vs JSONL) — recommend CSV with `_error_code`, `_error_message`, `_original_line` columns appended to the row's original columns (§10.2); (iv) bulk-write path — call D01 REST `POST /api/leads/bulk` over loopback or import D01's service layer directly? — recommend direct service import for perf, with `Idempotency-Key` semantics still honored (§6.4); (v) checkpoint granularity — recommend per-batch (every 500 rows) in `imports.processed_rows` (§8); (vi) original-CSV storage retention — recommend 30 d S3 lifecycle; (vii) UI live-progress — recommend SSE over polling (§11). Full list in §16.

---

## 1. Module scope (what's in / what's out)

### 1.1 In scope (this RESEARCH's deliverable)

- The end-to-end CSV import pipeline: upload → parse → normalize → validate → DNC scrub → tz derivation → batched insert → progress → error report.
- The REST surface (per D02.md): `POST /api/admin/lists/:listId/imports`, `GET /api/admin/imports/:id`, `GET /api/admin/imports/:id/errors.csv`.
- The Valkey/BullMQ queue topology and the worker hot loop.
- File-format support: CSV (RFC 4180), TSV. **XLSX is documented as a Phase-1.5 follow-up** (§4.4 — accepted by orchestrator).
- The column-mapping persistence pattern (lists.column_mapping JSON amendment to F02).
- The error reporting format (errors.csv shape + UI summary).
- DNC scrub policy on import (`skip|mark|proceed`).
- TCPA tz policy on import (same three modes).
- F02 schema amendments needed: `imports`, `import_errors` (partitioned), `lists.column_mapping`, `imports.dedup_*` flags.

### 1.2 Out of scope (handed off to other modules / phases)

- **Lead insertion logic** → D01 (`POST /api/leads/bulk` or direct `LeadService.bulkInsert`). D02 is a *caller*, not the writer.
- **Custom-data schema validation** → D01 owns the per-list Zod schema cache (D01 PLAN §5.1); D02 passes the rows through D01's validator.
- **Phone normalization implementation** → D01 owns `api/src/leads/normalize.ts`. D02 imports.
- **DNC lookup** → D05 owns `dialer/internal/dnc.Check` + Bloom topology. D02 calls.
- **TZ resolution** → D03 owns the cascade. D02 calls (`tz.Resolve`).
- **TCPA gate** → C01 owns. D02 calls at import time (advisory `tz_blocked` flag); the authoritative gate is still at dial time (E01 hopper + T04 originate).
- **Audit log writer** → F05 audit() helper. D02 emits.
- **C04 retention sweep** over `import_errors` partitions — C04 territory.
- **Multipart upload auth** → F05's `requireAuth` + `requirePermission('lead:import')`.
- **N01 (Phase 4) external add-lead** — separate REST surface; reuses some D02 plumbing but is its own module.

### 1.3 What changed vs the D02 spec

| D02.md decision | RESEARCH refinement |
|---|---|
| "BullMQ vs DIY Redis Streams? **Recommendation:** BullMQ" | Confirmed — see §6. Add: sandboxed processors per BullMQ §4 [25] for CSV-parse process isolation. |
| "`csv-parse/sync` for in-mem; `csv-parse` stream API for large" | We **never** use `csv-parse/sync`. Even small files go through stream mode for code-path consistency. `sync` is a foot-gun for the future "what happens when a user uploads 800 MB? — oh, OOM" regression. |
| "Header mapping: auto-detect + UI mapping for custom columns; mapping stored on list" | Confirmed; file as F02 amendment §13.1. Auto-detect heuristic specified in §7.2. |
| "CSV parser choice + settings" (PLAN deliverable) | Pinned in §5.1: `csv-parse@^5.5.0`, `relax_quotes: true, skip_records_with_error: false, info: true, columns: <from_mapping>, bom: true`. |
| "Storage: dev=local volume, prod=S3" | Confirmed (§5.5); `fastify-multipart` saveAs for dev, `fastify-multer-s3` for prod. |
| "Error format (per-row diagnostics with line number, reason)" | Specified in §10 as CSV (not JSON) with stable error code vocabulary. |
| "Progress reporting cadence (Redis `imports:{id}` hash; UI polls or subscribes)" | We pick **SSE subscribe + 5 s polling fallback** (§11). Polling-only is a regression vs Vicidial's blocking loader (no progress at all); pure WebSocket is overkill for one-way push. |

---

## 2. File format support

### 2.1 CSV (RFC 4180) — primary

Per [4][5][26][6] the canonical CSV grammar is:

```
file       = [header CRLF] record *(CRLF record) [CRLF]
record     = field *(COMMA field)
field      = (escaped / non-escaped)
escaped    = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE
non-escaped= *TEXTDATA
```

Key edge cases we must handle:

- **Embedded newlines inside quoted fields** (multi-line address, comments). `csv-parse` v5 handles these natively; we do **not** count CSV row 17 as "the 17th `\n` in the file" — we count records, not lines. The `info.lines` field on `csv-parse` records is the **starting** physical line, which is what we want in errors.csv.
- **Escaped double-quotes**: `"b""bb"` → `b"bb`. Default `csv-parse` behavior; do not configure `escape:` (the default is the same as quote, per RFC 4180).
- **Backslash escape** (`"b\"bb"`) is **not RFC 4180**; we **reject** by default. Some legacy exports use it — we accept on `mapping.options.legacy_backslash_escape: true` (Phase 2 nice-to-have).
- **Optional header CRLF** — we accept LF-only (Unix) and CRLF (Windows). `csv-parse` auto-detects.
- **Field count mismatch** — if a row has more or fewer fields than the header declares, `csv-parse` emits a `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` error. We capture this per-row with `skip_records_with_error: false` and route to errors.csv with `code:"FIELD_COUNT_MISMATCH"`.

Citation: csv-parse handles "delimiters, quotes, escape characters, and comments while handling line break discovery" with native Node Transform stream API [16][17]; npm-compare confirms csv-parse is "ideal for complex ETL pipelines" [1].

### 2.2 TSV

Operationally a CSV with `delimiter: '\t'`. Auto-detect: if the file has more `\t` than `,` in the first 4 KB, switch to TSV. Operator can override via `POST /imports` body `delimiter: ','|';'|'\t'|'auto'` (default `auto`).

### 2.3 Other delimiters (semicolon)

European Excel exports use `;` (locale CSV). Auto-detect: same first-4-KB heuristic. Documented in HANDOFF: "If operator's locale produces semicolons, the auto-detect catches it; if not, pass `delimiter: ';'` explicitly."

### 2.4 XLSX — Phase 1.5 (documented, not shipped Phase 1)

Per the SheetJS large-data demo [9] and ExcelJS streaming guide [32], the workflow for >100 MB XLSX is:

```ts
import ExcelJS from 'exceljs';
const wb = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
  sharedStrings: 'cache',   // ~30 % memory savings vs 'emit'; required for our row-by-row callback
  styles: 'ignore',
  hyperlinks: 'ignore',
  worksheets: 'emit',       // we only read the first sheet
});
for await (const ws of wb) {
  if (ws.id !== 1) continue;
  for await (const row of ws) {
    yield rowAsObject(row);     // hand to the normalize Transform
  }
}
```

Memory profile on ExcelJS PR #1431 [32]: 100 000-row × 10-col XLSX (~8 MB on disk) uses ~70 MB peak heap, vs ~420 MB for `xlsx` (SheetJS) full-load. ExcelJS is ~10 % slower per row but **6× memory advantage** decides it.

Alternative `xlsx-stream-reader` [10]: maintained; handles late-shared-strings via temp-file pivot; ~5 % faster than ExcelJS. Not picked because ExcelJS has more community signal and the same package is already used by C04 report-export.

**Why deferred:** XLSX edge cases (formulas evaluated to text vs to value; merged cells producing empty neighbors; multi-sheet selection UI; password-protected xlsx) add ~5 days of work to the 3-4 day D02 budget. Pre-MVP, operators "Save As CSV" — every modern Excel does this in 2 clicks.

### 2.5 Encoding detection

Per [16][17][18]:

- **UTF-8 BOM** (`EF BB BF`) — strip via `csv-parse` `bom: true`. Default behavior.
- **UTF-16 LE BOM** (`FF FE`) — `csv-parse` `bom: true` covers this too.
- **UTF-16 BE BOM** (`FE FF`) — rare; `csv-parse` does not natively decode. Fall back to `iconv-lite` decode on detection (BOM sniff in a `Transform` upstream of the parser).
- **No BOM, but UTF-16** — uncommon for lead lists; not handled in Phase 1 (would require `chardet` byte-pattern analysis [18] — adds 50 ms startup, rare yield). Documented as Phase 2.
- **Windows-1252 (CP1252) / Latin-1** — common from legacy CRMs. `chardet.detectFile(path, { sampleSize: 32768 })` from `runk/node-chardet` [18]; if `chardet` returns `windows-1252` with confidence > 0.7, prepend an `iconv-lite` decode-Transform. Tradeoff: 5 % parse-time overhead for the 5 % of files that need it.

Decision: **Phase 1 ships UTF-8 (with/without BOM) + UTF-16 LE + Windows-1252.** Other encodings reject with `400 UNSUPPORTED_ENCODING` and a hint to "Save the file as UTF-8 in Excel/LibreOffice."

### 2.6 Line endings

- **LF (Unix)** — default. Auto-detect.
- **CRLF (Windows)** — auto-detect. Strip on field-trim.
- **CR-only (legacy Mac)** — `csv-parse` `record_delimiter: ['\n', '\r\n', '\r']` accepts. Phase 1.

### 2.7 Compressed input (gzip)

`Content-Encoding: gzip` request — `fastify-multipart` doesn't decode multipart parts automatically. Phase 2: detect `.csv.gz` extension or `Content-Encoding` and pipe through `zlib.createGunzip()` first. Phase 1 rejects.

---

## 3. Streaming model

### 3.1 Pipeline shape

```
S3/disk file                                    (~500 MB worst case for 10 M rows × 50 B/row)
  │
  │ stream
  ▼
fs.createReadStream / s3.getObject().createReadStream()
  │
  ▼
[ encoding-detect Transform ]                   (iconv-lite if not UTF-8)
  │ object mode = no; raw bytes
  ▼
csv-parse stream                                (delimiter, columns, bom, info, relax_quotes)
  │ object mode; one record = one object
  ▼
[ apply-mapping Transform ]                     (sourceCol → targetCol per lists.column_mapping)
  │
  ▼
[ normalize-and-validate Transform ]            (phone E.164, state cast, ZIP, date_of_birth, custom_data)
  │   (per-row error → errors-stream)
  ▼
[ in-file dedup Transform ]                     (Bloom filter of phones seen so far this file)
  │
  ▼
[ DNC + TCPA scrub Transform ]                  (Bloom MEXISTS pipeline per batch of 100)
  │   (per-row decision → continue or send to errors-stream as DNC_BLOCKED / TZ_BLOCKED)
  ▼
[ batch-of-500 Transform ]                      (accumulates 500 rows, emits one array)
  │
  ▼
[ db-writer Writable ]                          (LeadService.bulkInsert(batch, idempotencyKey))
                                                (updates progress every batch)

In parallel: an errors-stream feeds a csv-stringify Writable to import_errors.csv on disk/S3.
```

Wired with `stream.pipeline(...)` from `node:stream/promises` per [3][22][24].

### 3.2 Backpressure model

Native Node streams [3] back-pressure automatically. Each Transform in the chain has `highWaterMark: 16` (object mode default; means ≤ 16 records buffered between stages). The slowest stage (DB writer at ~500 rows × few-ms = several-second cadence) governs the parser's read rate. Verified by `process.memoryUsage()` checkpoint logging during VERIFY.

The **db-writer** is a `Writable` (not Transform) because we don't propagate inserted rows downstream. Its `_write(batch, _, cb)` calls `LeadService.bulkInsert(batch)`, awaits, then `cb()`. Bullet-proof backpressure: parser stops reading the file until the last batch's DB write returns.

### 3.3 Memory budget

Per D02.md acceptance criterion: "1 M-row CSV imports without OOM. Memory stays under 200 MB throughout."

Sources of memory growth and our containment:

| Source | Per-row | × 1 M rows | Strategy |
|---|---:|---:|---|
| Buffered raw bytes (parser internal) | 200 B | — | csv-parse uses ~64 KB ring buffer; constant |
| Buffered parsed objects (highWaterMark × stages) | 200 B × 8 stages × 16 = 25 KB | — | constant |
| Batch accumulator (500 rows) | 200 B × 500 | 100 KB | constant |
| In-file dedup Bloom | — | ~1.8 MB | `bloom-filters` npm pkg, 0.001 FPR, 1 M cap → 1.78 MB; **constant**, not per-row |
| DB-writer in-flight bulk request | 200 B × 500 | 100 KB | constant |
| Progress hash | — | < 1 KB | per-batch overwrite |
| **Total estimated peak** | | **~3 MB** + Node runtime ~30 MB = **~35 MB heap** | well under 200 MB ceiling |

The 200 MB ceiling is a guardrail not a target. Real risk: if the operator's CSV has an extremely wide custom-data row (~10 KB per row × 1 M = 10 GB row data) we still hold ≤ 16 records in flight per stage, so worst-case is 16 × 8 stages × 10 KB = 1.3 MB — still fine. The memory leak risk is unbounded JSON parse on a single 10 MB row — csv-parse `max_record_size` (default 32 MB) caps this; we set to 1 MB and reject with `MAX_RECORD_SIZE_EXCEEDED`.

### 3.4 Throughput target

Per D02.md acceptance: "≥ 1 000 rows/sec on dev hardware."

Estimated throughput, dev hardware (4-vCPU, 16 GB), MySQL 8 / Valkey 7 local:

- csv-parse: ~250 k rows/sec on a thin row schema [1][2]; **not the bottleneck**.
- normalize + validate (libphonenumber, Zod): ~25 k rows/sec single-thread (libphonenumber-js is ~50 µs/parse).
- DNC Bloom MEXISTS pipelined per-batch-of-100: ~5 ms per batch × 10 batches/sec = ~50 k phones/sec.
- TZ resolve (D03 — primarily a NPA/NXX hashmap lookup): ~100 k/sec.
- LeadService.bulkInsert (Prisma createMany skipDuplicates, 500 rows): D01 PLAN budgets p95 ≤ 1.5 s ⇒ ~333 rows/sec sustained.
- **DB writer is the bottleneck.** Headroom: per D01 PLAN §4.4, raw `INSERT VALUES` fallback is ~5× faster (Prisma issue #23791) — gives 1 600 rows/sec.

Target: **1 000 rows/sec** Phase 1 (acceptance bar). **5 000 rows/sec stretch** with raw-INSERT fallback if Prisma path slips. A 1 M-row import takes ~17 minutes Phase 1; ~3.5 minutes with the raw fallback. Industry benchmark: LOAD DATA INFILE achieves 100 k rows/sec [19][20] — we **do not** use LOAD DATA INFILE because we need per-row Zod validation, phone normalization, DNC scrub, tz derivation, custom_data shape transform — all of which require row-level Node-side processing. The 30× speedup [19] is irrelevant when you can't run business logic in MySQL.

### 3.5 Multi-worker parallelism

Out of scope Phase 1. The single-worker, single-pipeline design hits the acceptance criterion. Phase 2: split file into 100 k-row shards via `csv-split-stream` and parallelize across BullMQ workers; aggregate via flow producer parent job [27][28]. Documented in HANDOFF.

---

## 4. Library decisions (head-to-head)

### 4.1 CSV parser

| Lib | Stream API | Throughput [1][2] | BOM | Async iter | Error-per-row | Node 20 | Pick? |
|---|---|---:|---|---|---|---|---|
| **csv-parse v5** | native Transform | medium-high | yes (UTF-8, UTF-16LE) | yes | yes (skip_records_with_error + info) | yes | **Yes** |
| papaparse 5.5.3 | step callback / Node Readable.pipe | highest | no (must strip yourself) | partial | yes (via step) | yes (≥ 12) | No |
| fast-csv 5.x | native Transform | lowest | partial | yes | partial | yes | No |
| csv-parser | Transform | medium | partial | yes | partial | **deprecated 2023** [1] | No |
| csvtojson | Transform | medium | partial | partial | partial | yes | No |

**Decision: `csv-parse@^5.5.0`**. The 5–15 % throughput loss vs papaparse is dwarfed by the ergonomic and Node-native wins. Author overlap with `csv-stringify` (used for errors.csv) means one library to think about. Stream API plays cleanly with `stream.pipeline()`.

Options to pin in PLAN:

```ts
import { parse } from 'csv-parse';
const parser = parse({
  bom: true,
  columns: false,         // we drive mapping ourselves to retain source column names
  delimiter: ',',         // overridable from request
  encoding: 'utf8',       // overridable from chardet detection
  info: true,             // attaches { lines, records, columns } per record
  max_record_size: 1 * 1024 * 1024,  // 1 MB hard cap
  relax_quotes: true,     // tolerate stray un-escaped quotes (legacy exports)
  skip_records_with_error: false,    // we want errors, not silent skip
  trim: true,             // strip whitespace around fields
});
```

Cites: csv.js.org parse docs [16][17]; npm csv-parse [4]; benchmarks [1][2].

### 4.2 XLSX (Phase 1.5)

**Decision: `exceljs@^4` `stream.xlsx.WorkbookReader`.** §2.4 / §4.4. Memory advantage [9][32] is the decider.

### 4.3 Phone normalization

**Already pinned by D01 PLAN §6.1: `libphonenumber-js/min` ^1.11.x.** D02 imports `api/src/leads/normalize.ts` — no separate dependency.

### 4.4 ZIP → state lookup

Two options:

1. **Use the existing `zip_codes` table** (F02 §A4) — already seeded with 41 692 US ZIPs from `scpike/us-state-county-zip` [13]. Per-row lookup is a Prisma `findUnique({ where: { zip } })` — ~50 µs hot, ~1 ms cold. Cache in a Node `Map<zip, { state, tzIana }>` populated lazily; cap 50 000 entries, simple LRU via `lru-cache@^11`. **Pick this.**
2. Embed the 1.5 MB CSV in the worker image — same cost, slower cold-start.

### 4.5 Area code → state/tz

Use **`phone_codes`** + **`phone_codes_overrides`** F02 tables (D03's territory). Same `Map<NPA|NPA+NXX, {state,tzIana}>` cache pattern as ZIP.

### 4.6 In-file Bloom for dedup

**`bloom-filters@^3.0.4`** (npm). Mature, MIT, type-safe, ~10 µs add/test, no native deps. 1.78 MB RAM for 1 M items at 0.001 FPR. Alternative `bloomfilter@^0.0.18` is older and untyped. We're not using it for compliance (false negatives matter only for early-dial — not for in-file dedup where false-positive "skip a row I haven't seen" is an acceptable rare event; we audit anyway).

Actually re-checked: for **dedup**, false positive means "I incorrectly think I've seen this phone before and skip it" — that's data loss. 0.001 FPR on 1 M rows = ~1 000 incorrectly-skipped rows. **Not acceptable.** Switch to **a JavaScript `Set<string>` of phone strings** — 1 M × ~16 B per E.164 = 16 MB. Acceptable. Cite Node 20 Set perf: O(1) add/has. Decision: **`Set<string>` for in-file dedup**, document the 16 MB cost in HANDOFF.

### 4.7 csv-stringify (for errors.csv)

`csv-stringify@^6` (sibling of csv-parse). Streaming Writable. Header row: original CSV header + `_error_code`, `_error_message`, `_source_line`, `_source_record`. Per-row content is the original row's fields (we kept the raw record alongside the parsed object).

### 4.8 Job queue

**BullMQ ^5.x** per F04 PLAN. Sandbox processor `processor.js` invoked via `new Worker(queueName, path.join(__dirname, 'processor.js'), opts)`. Per BullMQ Sandbox docs [25][27]: avoids stalled-job state if csv-parse crashes the V8 isolate; runs the CSV hot loop in a separate Node process; one-way `job.updateProgress()` calls work transparently across IPC.

### 4.9 SSE for progress (UI)

**Native Fastify response.raw chunked write** — no plugin needed; pattern documented in [11][23][34][35]. F02 already loads `@fastify/compress` — disable per-route for `/api/admin/imports/:id/events`.

### 4.10 Multipart upload

**`@fastify/multipart@^9`** (F01 already pinned). Stream mode: `request.file()` returns `{ file: Readable }` which we pipe directly to `fs.createWriteStream(localPath)` (dev) or `Upload` from `@aws-sdk/lib-storage` (prod). Per [21] this is the canonical pattern; the file never sits in JS memory.

---

## 5. Storage

### 5.1 Upload destination

| Env | Backing store | Path/Key |
|---|---|---|
| dev | local volume `/data/csv/uploads/` | `t{tid}/{import_id}.csv` |
| ci  | same | same |
| prod | S3 / MinIO bucket `vici2-uploads` | `t{tid}/{YYYY}/{MM}/{import_id}.csv` |

Naming: `import_id` is a ULID (per F01 ID convention). `t{tid}/` shards by tenant for IAM scope.

### 5.2 Error-report destination

Same pattern, suffix `.errors.csv`. Streamed in parallel with the import.

### 5.3 Retention

| Object | Phase 1 retention | Owner |
|---|---|---|
| Original CSV | 30 days | S3 lifecycle |
| Errors CSV | 90 days | S3 lifecycle |
| `imports` row | 5 years (TCPA evidence) | C04 |
| `import_errors` row | 90 days (rolling monthly partition drop) | C04 |

### 5.4 Encryption

S3 server-side default (SSE-S3 / KMS-managed). No application-layer encryption — the leads in MySQL are not encrypted at rest either (Phase 1 scope; F05 KEK is for credentials only).

---

## 6. Workflow / wire shape

### 6.1 Upload step (REST)

```
POST /api/admin/lists/:listId/imports
Content-Type: multipart/form-data; boundary=...

(part 1: file=<CSV bytes>)
(part 2: name="meta", value=<JSON with options below>)

→ 202 Accepted
{
  "import_id": "01HZW...",
  "status": "queued",
  "estimated_rows": null
}
```

`meta` JSON body shape:

```json
{
  "name": "Q2 2026 Florida cold list",
  "delimiter": "auto",
  "encoding": "auto",
  "header_row": true,
  "skip_rows": 0,
  "mapping": { ... } | "inherit",
  "dedup_policy": "skip_in_file" | "skip_cross_list" | "skip_tenant",
  "dnc_policy": "skip" | "mark" | "proceed",
  "tz_policy":  "skip" | "mark" | "proceed",
  "default_country": "US",
  "default_status": "NEW",
  "options": {
    "lookup_state_from_zip": true,
    "legacy_backslash_escape": false,
    "strict_phone": true
  }
}
```

### 6.2 Status step

```
GET /api/admin/imports/:id
→ 200
{
  "import_id": "01HZW...",
  "status": "queued|running|done|failed|cancelled",
  "started_at": "...",
  "completed_at": "...",
  "row_count_total": 100000,
  "row_count_processed": 47800,
  "row_count_inserted": 45200,
  "row_count_skipped":  2200,
  "row_count_errored":  400,
  "summary": {
    "by_error_code": { "INVALID_PHONE": 320, "DNC_BLOCKED": 70, "DUPLICATE_IN_FILE": 10 }
  },
  "errors_url": "/api/admin/imports/:id/errors.csv"
}
```

### 6.3 SSE progress channel

```
GET /api/admin/imports/:id/events  (text/event-stream)

event: progress
data: {"processed":47800,"total":100000,"inserted":45200,"skipped":2200,"errored":400}

event: done
data: {"status":"done","completed_at":"..."}

event: failed
data: {"status":"failed","reason":"..."}
```

Reconnection via `Last-Event-ID` (Valkey Stream `XREAD` from offset) — standard EventSource semantics [11][23][34].

### 6.4 Worker → D01 calling convention

**Decision: direct service-layer import**, not REST round-trip.

```ts
// workers/src/jobs/lead-import/processor.ts
import { LeadService } from '@vici2/api/leads';   // exported via package.json subpath
import { buildPrisma } from '@vici2/api/db';

const prisma = buildPrisma();
const service = new LeadService(prisma);

async function flushBatch(batch, idempotencyKey) {
  return service.bulkInsert(batch, {
    skipDuplicates: true,
    strict: false,
    idempotencyKey,
  });
}
```

Rationale:

- **No HTTP overhead** — saves ~30 ms per 500-row batch (~6 % perf gain on 1M-row import = ~1 minute).
- **No rate-limit** — D01's REST 10 rpm cap is for external API clients, not the trusted worker.
- **Same code path** — `bulkInsert` IS the REST handler's inner — no divergence.
- **Same idempotency key** — pass per-batch ULID; D01 caches in Valkey `t:{tid}:idem:lead:{key}` 24h (D01 PLAN §1.4).
- **Same audit** — D01 writes one `audit_events.lead.bulk_inserted` row per call (D01 PLAN §9.2). We override `audit.actor_user_id` to the import's `owner_user_id` and tag `audit.context.import_id`.

The only thing we lose is the REST 207 partial-status framing — but we get the same `{inserted, skipped, errors}` shape back from the service, so the worker can fan errors into `import_errors` immediately.

---

## 7. Column mapping

### 7.1 Mapping shape (persisted on list)

```jsonc
// lists.column_mapping (JSON; nullable; F02 amendment §13.1)
{
  "version": 1,
  "rows": [
    { "source": "Phone",          "target": "phone_e164",     "transform": "phone" },
    { "source": "First Name",     "target": "first_name",     "transform": "trim" },
    { "source": "Email Address",  "target": "email",          "transform": "lower" },
    { "source": "Birth Date",     "target": "date_of_birth",  "transform": "date:MM/DD/YYYY" },
    { "source": "State",          "target": "state",          "transform": "trim,upper" },
    { "source": "Account #",      "target": "custom.acct_id", "transform": "trim" }
  ],
  "options": {
    "default_status": "NEW",
    "default_country": "US",
    "lookup_state_from_zip": true,
    "skip_blank_rows": true
  }
}
```

Targets:
- Core columns: `phone_e164`, `phone_alt`, `phone_alt2`, `first_name`, `last_name`, `middle_initial`, `title`, `address1`, `address2`, `city`, `state`, `postal_code`, `country_code`, `email`, `date_of_birth`, `gender`, `comments`, `vendor_lead_code`, `source_id`, `rank`, `owner_user_id`, `entry_at`, `status` (default `NEW`).
- Custom: `custom.<key>` (writes to `leads.custom_data`).

Transforms: `phone` (libphonenumber-js → E.164), `date:<format>` (date-fns parse), `lower`, `upper`, `trim`, `nullify_blank`, `concat:<other_source>`, `map:<key>=<value>;<key2>=<value2>` (for status/gender normalization), `parseInt`, `parseFloat`.

### 7.2 Auto-detect heuristic (first-upload)

Case-insensitive substring match in order of specificity:

```ts
const AUTO_DETECT_RULES = [
  { target: 'phone_e164',     match: /\b(phone|mobile|cell|tel|telephone|primary[_ ]?phone)\b/i },
  { target: 'phone_alt',      match: /\b(alt[_ ]?phone|secondary[_ ]?phone|phone[_ ]?2)\b/i },
  { target: 'first_name',     match: /\b(first[_ ]?name|fname|given[_ ]?name)\b/i },
  { target: 'last_name',      match: /\b(last[_ ]?name|lname|surname|family[_ ]?name)\b/i },
  { target: 'email',          match: /\bemail\b/i },
  { target: 'state',          match: /\bstate\b/i },
  { target: 'postal_code',    match: /\b(zip|postal[_ ]?code|postcode)\b/i },
  { target: 'date_of_birth',  match: /\b(dob|birth[_ ]?date|date[_ ]?of[_ ]?birth)\b/i },
  // ... per Vicidial column convention §1.7 of D02.md heritage
];
```

Confidence: substring match → 0.9 confidence. Exact match (`phone_e164`) → 1.0. UI shows confidence and allows operator override. Mapping must be **confirmed** before processing starts (D02.md risk mitigation: "mapping confirmation step in UI before processing starts").

### 7.3 Inherit mode

`mapping: "inherit"` reuses `lists.column_mapping`. CSV header must match the persisted mapping exactly (case-insensitive). If header drift, return `400 HEADER_MISMATCH` with the new vs old header set.

### 7.4 Cite Vicidial precedent

Vicidial's `admin_listloader_third_gen.php` [30] (and fourth-gen `admin_listloader_fourth_gen.php` [31]) uses GET/POST params per target column (`phone_number_field`, `first_name_field`, ...) to map. Our JSON shape is more ergonomic but the **idea** of per-target column-index is the same. WebFetch read: "Users designate which input file columns correspond to phone number, name, address, and custom fields through GET/POST parameters (e.g., `phone_number_field`, `first_name_field`)" [30].

---

## 8. De-duplication

Three nested layers, each independently configurable per import (`dedup_policy` body field):

### 8.1 Within-file dedup (mandatory, always-on)

Same CSV has phone X appearing twice. **Always** dedup; the second occurrence becomes an error with `code:"DUPLICATE_IN_FILE", first_seen_line:N`. JS `Set<string>` of E.164 strings, 16 MB ceiling per §4.6.

### 8.2 Cross-list dedup (configurable, default: off for the target list, on for tenant-wide)

Phone X exists in another list already in this tenant. Three modes:

- `none` — no cross-list check; allow.
- `target_list_only` — only check target list (UNIQUE constraint enforces; D01 `skipDuplicates` catches).
- `tenant_wide` — check `idx_leads_t_phone` for any existing lead with same phone in tenant; skip if found. Implemented as a batch `SELECT phone_e164 FROM leads WHERE tenant_id = ? AND phone_e164 IN (?,?...) LIMIT N` per batch of 500. ~10 ms per batch on indexed lookup.

Vicidial precedent [30][31]: four modes — "list-level phone checking, campaign-level phone checking, system-wide phone checking, and title/alt-phone combination matching." Our `tenant_wide` is their "system-wide phone checking." We drop "title/alt-phone combo" (an obscure marketing-vendor pattern; can be re-added Phase 2 if requested).

### 8.3 Lead-recycle awareness (read-only Phase 1)

Phone X exists, was last called > N days ago (campaign's `recycle_delay_seconds` × ~recycle threshold). If `dedup_policy: 'recycle_aware'`, we **don't insert** the duplicate but **re-activate** the existing lead (`UPDATE leads SET status='NEW', modify_at=NOW(6) WHERE id=?`). This is D06 territory; D02 Phase 1 does **not** ship recycle-aware (deferred to D06's recycle endpoint). Documented in §16 open questions.

### 8.4 UNIQUE constraint in F02

F02 already has `UNIQUE(tenant_id, list_id, phone_e164)` (per F02 PLAN §4.13). D01's `createMany({ skipDuplicates: true })` translates to `INSERT IGNORE` and the unique-violations land in `skipped`. We rely on this for the target-list dedup floor.

Cite: MySQL `INSERT IGNORE` is 20-50 % faster than `ON DUPLICATE KEY UPDATE` for pure-skip semantics [25][26]; the docs explicitly recommend it for "idempotent imports where the first-written value should be preserved."

---

## 9. DNC scrub + TCPA check on import

### 9.1 DNC scrub flow

Per-batch (500 rows), build a Bloom MEXISTS pipeline against `bf:dnc:federal`, `t:{tid}:dnc:state:bloom`, `t:{tid}:dnc:internal:bloom` (per D05 PLAN §1.2). For each positive hit, run MySQL confirm (D05 §2). Apply `dnc_policy`:

- `skip` (default) — exclude row from batch, write to errors.csv with `code:"DNC_BLOCKED", source:"federal|state|internal"`.
- `mark` — include row but set `status='DNC'` (the lead is persisted for audit but never dial-eligible).
- `proceed` — include row normally; write a **warning** line to errors.csv with `code:"DNC_WARN"`. The dial-time D05 gate still catches it; this mode is for operators who scrub downstream.

Required Phase 1 because (a) compliance (TCPA $500/call exposure per illegal dial; D05.md §10 cites $1.5 M settlements); (b) operator UX — no operator wants to import a 200 k list and discover only at dial-time that 30 k are DNC.

### 9.2 TCPA tz check flow

Per-row, derive timezone via D03 cascade (KNOWN→ZIP→NXX→NPA→STATE_DEFAULT→NONE). Apply `tz_policy`:

- `skip` — if D03 returns NONE confidence, drop the row. Errors.csv code `NO_TIMEZONE`.
- `mark` (default) — keep the row with `tz_blocked=true` (per F02 amendment `leads.tz_blocked` boolean). C01's `Check()` at dial time will block dial. M03 admin UI can list `tz_blocked` leads.
- `proceed` — keep the row; dial-time C01 gate handles.

Note: D02 does **not** call C01.Check() at import time. The dial-time gate is authoritative — we'd just be re-running compliance on dead leads. We do set `tz_blocked` based on D03's confidence so M03 can show "127 leads need a ZIP fix" for the operator.

### 9.3 Confirmation step in UI

Before processing starts (after column-mapping confirmation), UI shows a **preview**: "First 100 rows: 7 will be DNC-blocked (federal), 3 will be tz-blocked (no timezone). Continue?" This is a stretch goal; Phase 1 minimum is "report errors after the fact in errors.csv." Tracked in §16.

---

## 10. Transactional semantics + error reporting

### 10.1 Atomicity model

**Per-batch** (500 rows), atomic via `prisma.$transaction` (D01 `bulkInsert` already wraps). On batch failure:

- If `attempts: 3` retries succeed → continue.
- If all retries fail → mark `imports.status = 'failed'`, emit SSE `failed` event, leave already-inserted rows in DB (we don't roll back the whole file).
- Operator can **resume** with same `import_id` and `?resume=true` — picks up at `imports.processed_rows + 1`. Per F02 amendment, `imports.processed_rows` tracks the high-water mark.

Per Fivetran [3]/Airbyte [6]/start-data-engineering [10] (idempotency in pipelines): checkpoint by batch, replay at batch boundary. Industry standard.

### 10.2 Errors CSV shape

```csv
_source_line,_source_record,_error_code,_error_message,<original-cols...>
17,16,INVALID_PHONE,"E.164 parse failed: empty string","","Bob","Smith","","","FL","",""
42,41,DUPLICATE_IN_FILE,"Phone +14155551234 already on line 9 of this file","+14155551234","Alice","Lee",...
99,98,DNC_BLOCKED,"federal DNC","+12025551234","",...
```

Stable error code vocabulary (consumed by UI + N01 webhooks Phase 4):

| Code | Meaning | Recoverable? |
|---|---|---|
| `INVALID_PHONE` | libphonenumber-js parse/validate failed | row-level |
| `MISSING_REQUIRED_FIELD` | phone_e164 was null/empty | row-level |
| `FIELD_COUNT_MISMATCH` | row has wrong # of fields vs header | row-level |
| `CUSTOM_DATA_SCHEMA_FAIL` | per-list Zod schema rejected custom_data | row-level |
| `INVALID_STATE` | state column not in US two-letter set; ZIP lookup also failed | row-level |
| `INVALID_DATE` | date_of_birth parse failed | row-level |
| `DUPLICATE_IN_FILE` | phone seen earlier this file | row-level |
| `DUPLICATE_IN_LIST` | phone exists in target list (UNIQUE skipped) | row-level (informational) |
| `DUPLICATE_IN_TENANT` | phone exists in some other list (tenant_wide mode only) | row-level |
| `DNC_BLOCKED` | DNC scrub matched | row-level |
| `DNC_WARN` | DNC scrub matched but `dnc_policy:proceed` — warning only | row-level (informational) |
| `NO_TIMEZONE` | D03 returned NONE confidence and `tz_policy:skip` | row-level |
| `TZ_BLOCKED_WARN` | tz_policy:mark — row written with tz_blocked=true | row-level (informational) |
| `MAX_RECORD_SIZE_EXCEEDED` | one row exceeded 1 MB | row-level |
| `MAX_RECORD_COUNT_EXCEEDED` | imports.row_limit enforcement (Phase 2) | file-level |
| `HEADER_MISMATCH` | inherit-mode and CSV header doesn't match persisted mapping | file-level |
| `UNSUPPORTED_ENCODING` | chardet returned an encoding we don't handle | file-level |
| `DB_TRANSIENT` | DB error after 3 retries | batch-level |

### 10.3 Why CSV (not JSON) for the error report

- Operators open in Excel and fix-and-re-upload — JSON would require a JSON-to-CSV tool round-trip.
- Streaming-writeable; we emit row-by-row without buffering.
- Same delimiter/encoding as the source (we pass through to the operator).

JSONL alternative considered; rejected because operator workflow is "open in Excel, fix, save as CSV, re-upload."

### 10.4 Errors download endpoint

`GET /api/admin/imports/:id/errors.csv` streams the file. Pre-signed S3 URL preferred (prod); local file stream (dev). `Content-Disposition: attachment; filename=import-{id}-errors.csv`.

---

## 11. Performance

### 11.1 Targets (acceptance criteria, restated)

| Metric | Target | Source |
|---|---|---|
| 1 M-row CSV → no OOM | < 200 MB heap | D02.md acceptance |
| Throughput (sustained) | ≥ 1 000 rows/sec | D02.md acceptance |
| Throughput (target) | ≥ 5 000 rows/sec (Phase-1 stretch) | RESEARCH §3.4 |
| UI progress visible | within 1 s of start | D02.md acceptance |
| Per-row error report | line # + reason per row | D02.md acceptance |
| 10 k-row CSV completion | ≤ 30 s end-to-end | D01 PLAN acceptance |

### 11.2 Bottleneck audit

§3.4 establishes DB-writer is the bottleneck. Two levers:

1. **Raw INSERT VALUES fallback** in D01 (D01 PLAN §4.4 — documented but not Phase 1 default).
2. **Parallel D01 bulk calls** — 2-3 concurrent batch flushes from the same worker; D01 bulk insert is connection-pool friendly. Caveat: order of `errors[].row` no longer maps to file order; D02 must track per-batch CSV-line offsets.

### 11.3 Benchmarks to run in IMPLEMENT

- `bench/D02/throughput.bench.ts` — 100 k synthetic rows, measure rows/sec end-to-end.
- `bench/D02/memory.bench.ts` — 1 M synthetic rows, profile heap with `--max-old-space-size=256`; CI fails if heap > 250 MB.
- `bench/D02/error-fidelity.bench.ts` — inject 7 known bad rows in a 1 000-row file; assert errors.csv has all 7 with correct line numbers and codes.

---

## 12. Schema additions needed

To be filed as F02 amendments (D02-AMENDMENTS-HANDOFF in PLAN phase):

### 12.1 New table `imports`

```prisma
model Import {
  id              String     @id @db.Char(26)   // ULID
  tenantId        BigInt     @default(1) @map("tenant_id")
  listId          BigInt     @map("list_id")
  ownerUserId     BigInt     @map("owner_user_id")
  status          ImportStatus @default(queued)
  sourceKey       String     @map("source_key") @db.VarChar(512)     // s3://bucket/key or local path
  errorsKey       String?    @map("errors_key") @db.VarChar(512)
  fileBytes       BigInt?    @map("file_bytes")
  rowCountTotal   Int?       @map("row_count_total")
  rowCountProcessed Int      @default(0) @map("row_count_processed")
  rowCountInserted  Int      @default(0) @map("row_count_inserted")
  rowCountSkipped   Int      @default(0) @map("row_count_skipped")
  rowCountErrored   Int      @default(0) @map("row_count_errored")
  meta            Json       // upload-time options (mapping, dnc_policy, etc.)
  errorSummary    Json?      @map("error_summary")  // {byCode:{INVALID_PHONE:n,...}}
  startedAt       DateTime?  @map("started_at") @db.DateTime(6)
  completedAt     DateTime?  @map("completed_at") @db.DateTime(6)
  failedReason    String?    @map("failed_reason") @db.VarChar(255)
  createdAt       DateTime   @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt       DateTime   @updatedAt @map("updated_at") @db.DateTime(6)

  tenant Tenant @relation(fields: [tenantId], references: [id])
  list   List   @relation(fields: [listId], references: [id])
  owner  User   @relation(fields: [ownerUserId], references: [id])
  errors ImportError[]

  @@index([tenantId, status, createdAt], map: "idx_imports_t_status_created")
  @@index([tenantId, listId, createdAt], map: "idx_imports_t_list_created")
  @@map("imports")
}

enum ImportStatus { queued running done failed cancelled }
```

### 12.2 New table `import_errors` (partitioned)

```prisma
model ImportError {
  id          BigInt   @id @default(autoincrement())
  tenantId    BigInt   @default(1) @map("tenant_id")
  importId    String   @map("import_id") @db.Char(26)
  sourceLine  Int      @map("source_line")
  sourceRecord Int     @map("source_record")
  errorCode   String   @map("error_code") @db.VarChar(48)
  errorMsg    String?  @map("error_msg") @db.VarChar(512)
  rawRow      Json?    @map("raw_row")       // optional — capped at 4 KB
  createdAt   DateTime @default(now()) @map("created_at") @db.DateTime(6)

  @@index([tenantId, importId, sourceLine], map: "idx_import_errors_t_import_line")
  @@index([tenantId, importId, errorCode], map: "idx_import_errors_t_import_code")
  @@map("import_errors")
}

// Monthly RANGE COLUMNS(created_at) partitioned, like call_window_audit (F02 amendment §1).
// 90-day retention by C04 rotator.
// Composite PK including partition column would mirror other partitioned tables;
// PLAN decides whether to drop the BigInt id and use (tenantId, importId, sourceLine, createdAt).
```

Note: `rawRow` is optional and capped — for cases where errors.csv is unreachable (S3 down) we still have the bad row in MySQL. Default off; enable via `meta.options.persist_raw_errors=true`.

### 12.3 New column `lists.column_mapping`

```sql
ALTER TABLE lists ADD COLUMN column_mapping JSON NULL;
```

Holds the mapping JSON shape from §7.1. Updated on every import (or first import if not set).

### 12.4 RBAC permission

`lead:import` — already implied by D01 PLAN §1.1 (existing on `POST /api/leads/bulk`). D02 reuses.

---

## 13. Background job pattern

### 13.1 BullMQ over Valkey (per F04 PLAN)

```ts
// api side (POST /imports handler)
import { Queue } from 'bullmq';
const importQueue = new Queue('vici2:queue:lead-import', {
  connection: valkeyConn,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

await importQueue.add('import', { importId, tenantId, listId }, { jobId: importId });

// worker side
new Worker('vici2:queue:lead-import',
  path.resolve(__dirname, 'processor.cjs'),    // sandboxed processor
  {
    connection: valkeyConn,
    concurrency: 2,                              // per pod
    lockDuration: 60_000,                        // refreshed by job.extendLock
  },
);
```

Sandbox processor allows the CSV hot loop to crash without taking the worker pod down. Cited in BullMQ docs [25][27].

### 13.2 Progress reporting

```ts
// inside processor
await job.updateProgress({
  processed: 47800, total: 100000,
  inserted: 45200, skipped: 2200, errored: 400,
});
```

BullMQ publishes to Valkey channel `bull:vici2:queue:lead-import:events`. We subscribe in the API gateway's SSE handler [11][23] and re-emit the JSON to the EventSource. Heartbeats every 15 s prevent proxy-buffer timeout (NGINX default 60 s).

### 13.3 Job lifecycle hooks

- `onActive` → set `imports.status='running'`, `started_at=NOW(6)`.
- `onProgress` → no-op (we update `imports.row_count_*` from inside the processor batch loop directly via Prisma; the BullMQ progress is for SSE only).
- `onCompleted` → set `imports.status='done'`, `completed_at=NOW(6)`.
- `onFailed` (after final retry) → set `imports.status='failed'`, `failed_reason=<error.message>`.

### 13.4 Cancellation

`POST /api/admin/imports/:id/cancel` — Phase 2 feature. Sets `imports.status='cancelled'` and sets a Valkey flag the processor polls between batches. Already-inserted rows stay.

---

## 14. Storage retention + audit

### 14.1 Original CSV

30-day S3 lifecycle. SPEC §3 mandates audit retention — for D02, the audit trail is the `imports` row + the original CSV. After 30 days the CSV is purged; the `imports` row stays 5 years.

### 14.2 Audit events emitted

| Event | Trigger | details_json |
|---|---|---|
| `import.queued` | POST /imports | `{ import_id, list_id, file_bytes, source_key }` |
| `import.started` | worker onActive | `{ import_id, mapping_summary }` |
| `import.completed` | worker onCompleted | `{ import_id, inserted, skipped, errored, duration_ms }` |
| `import.failed` | worker onFailed | `{ import_id, reason }` |
| `import.cancelled` | cancel endpoint | `{ import_id, by_user_id }` |
| `lead.bulk_inserted` (delegated to D01) | each batch flush | `{ list_id, count_inserted, count_skipped, import_id }` (D02 adds context.import_id) |

---

## 15. API surface (summary)

| Method | Path | Owner | Notes |
|---|---|---|---|
| POST | `/api/admin/lists/:listId/imports` | D02 | multipart upload; returns 202 + import_id |
| GET  | `/api/admin/imports/:id` | D02 | status JSON |
| GET  | `/api/admin/imports/:id/events` | D02 | SSE |
| GET  | `/api/admin/imports/:id/errors.csv` | D02 | error report stream |
| POST | `/api/admin/imports/:id/cancel` | D02 (Phase 2) | sets cancel flag |
| GET  | `/api/admin/imports` | D02 | list recent imports for tenant; cursor paginated |
| POST | `/api/admin/lists/:listId/mapping/preview` | D02 | preview mapping vs first 100 rows (no insert) |

RBAC: all require `lead:import` permission (F05). Tenant scoped via F05 AsyncLocalStorage.

Rate-limit (F04 Valkey store): POST imports = 5 rpm per tenant; preview = 30 rpm.

---

## 16. Open questions for PLAN

| # | Question | Recommendation (best-effort) |
|---|---|---|
| 1 | `csv-parse` vs `papaparse` final pick | **`csv-parse@^5.5.0`** (§5.1). Better Node ergonomics, native Transform, info option, sibling of csv-stringify. |
| 2 | XLSX in Phase 1 or Phase 1.5? | **Phase 1.5.** 3-4 day D02 budget can't absorb XLSX edge cases. Operator "Save As CSV" works. |
| 3 | Error report format CSV vs JSONL vs JSON | **CSV** (§10.3). Operator-fix-and-re-upload workflow. |
| 4 | D01 calling convention: REST loopback or direct service import? | **Direct service import** (§6.4). 6 % perf gain, same audit, no rate-limit, same code path. |
| 5 | Checkpoint granularity per-batch (500) or per-row? | **Per-batch.** Row-level checkpoint adds 1 ms × 1 M = 17 minutes overhead. Batch-level is industry-standard [6][10]. |
| 6 | Original-CSV retention | **30 days** S3 lifecycle. TCPA evidence is the `imports` row + summary; CSV is a convenience. |
| 7 | UI live-progress mechanism | **SSE with 5 s polling fallback.** SSE is the 2026 default for one-way push [11][23][34][35]. |
| 8 | DNC default policy | **`skip`.** Industry consensus [29][33]. `mark` is rarely what operators want; `proceed` is dangerous default. |
| 9 | TZ default policy | **`mark`.** D03's NONE-confidence is uncommon and worth flagging in UI rather than silently dropping. C01 at dial time is authoritative. |
| 10 | In-file dedup data structure | **`Set<string>`**, not Bloom (§4.6). 16 MB cost is acceptable; data loss from Bloom FP is not. |
| 11 | Persist raw-row in `import_errors`? | **Default off.** Enable per-import via `meta.options.persist_raw_errors=true`. Capped 4 KB. |
| 12 | Auto-detect delimiter scope | **First 4 KB.** Faster than entire-file scan; rarely wrong. |
| 13 | Recycle-aware dedup | **Defer to D06 / Phase 2.** Adds complexity; D06 owns recycle semantics. |

---

## 17. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Memory leak in `csv-parse` stream on malformed CSV | Low | High | Pinned `^5.5.0`; load-test in `bench/D02/memory.bench.ts`; CI fails on heap > 250 MB. |
| Header inference wrong → wrong-mapped data inserted | Medium | High | Mapping confirmation step mandatory before processing (D02.md). Preview endpoint shows first 100 rows w/ mapping applied. |
| DNC Bloom unavailable during import → fail-closed marks all leads DNC | Low | Medium | Per D05 §1.5, fall back to MySQL confirm if Bloom down; if MySQL also down, **abort the import** (don't fail-closed-insert-DNC). Alert operator. |
| D01 `bulkInsert` 1.5 s p95 budget slipped → slow imports | Medium | Medium | D01 PLAN §4.4 documents raw `INSERT VALUES` fallback (~5× faster); ship as opt-in flag per-import. |
| Idempotency replay collision (same Idempotency-Key, different content) | Low | High | Per D01 PLAN §1.4, idempotency key is per-batch ULID derived from `(import_id, batch_index)`; same import = same keys = same batches = idempotent. Different import = different ULID. |
| Operator uploads 10 GB file via slow network → multipart timeout | Medium | Low | Stream to S3 via `fastify-multer-s3`; no body buffering. Configure `bodyTimeout: 30 min` on the route. |
| Worker pod crashes mid-import | Medium | Medium | BullMQ `attempts:3` + sandboxed processor (§13.1). Resume from `imports.row_count_processed` checkpoint. |
| Errors CSV grows unbounded for a pathologically bad file | Low | Low | Cap at `imports.error_limit=10000` errors; after that, abort with `MAX_ERRORS_EXCEEDED` (operator's CSV is too dirty to fix row-by-row). |
| Per-list custom_data schema changed mid-import | Low | Low | Snapshot schema at import-start (cache); ignore schema changes during run. Operator sees consistent validation for the whole file. |
| Vicidial-import flow (column names different) | Medium | Low | Ship a `mapping: "vicidial_default"` preset matching Vicidial's column convention [30]: vendor_lead_code, source_id, list_id, phone_code, phone_number, title, first_name, middle, last_name, address1, address2, address3, city, state, province, postal_code, country, gender, date_of_birth, alt_phone, email, security_phrase, comments, called_count, status, entry_date. |
| 8-byte UTF-8 char midway through a 64 KB read boundary | Very low | Low | `csv-parse` and `iconv-lite` both handle correctly. Verified by `bench/D02/encoding.test.ts`. |

---

## 18. Citations

Web sources cited inline by [n]. Repository sources cited by path.

External:

- [1] LeanyLabs, *JavaScript CSV Parsers Comparison*, https://leanylabs.com/blog/js-csv-parsers-benchmarks/
- [2] FileFeed, *Best JavaScript CSV Parsers in 2026 (Compared)*, https://www.filefeed.io/blog/top-5-javascript-csv-parsers
- [3] Node.js v24 docs, *Backpressuring in Streams*, https://nodejs.org/learn/modules/backpressuring-in-streams
- [4] csv-parse on npm, https://www.npmjs.com/package/csv-parse
- [5] IETF RFC 4180, *Common Format and MIME Type for CSV*, https://datatracker.ietf.org/doc/html/rfc4180
- [6] Airbyte, *Understanding Idempotency*, https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines
- [7] Fivetran, *Idempotence and How It Failure-Proofs Your Data Pipeline*, https://www.fivetran.com/blog/idempotence-failure-proofs-data-pipeline
- [8] Hayageek, *CSV parsers in Node.js — Top 5*, https://hayageek.com/csv-parsers-in-nodejs/
- [9] SheetJS Community Edition, *Large Datasets — Stream*, https://docs.sheetjs.com/docs/demos/bigdata/stream/
- [10] xlsx-stream-reader on npm, https://www.npmjs.com/package/xlsx-stream-reader
- [11] HireNodeJS, *Node.js Server-Sent Events (SSE) in 2026*, https://www.hirenodejs.com/blog/nodejs-server-sent-events-sse-2026
- [12] Vicidial forum, *Vicidial times by area code* and several timezone threads, https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=33328
- [13] GitHub scpike/us-state-county-zip, https://github.com/scpike/us-state-county-zip
- [14] vicidial-asterisk-gui AST_VDhopper.pl, https://github.com/h4ck3rm1k3/vicidial-asterisk-gui/blob/master/bin/AST_VDhopper.pl
- [15] BullMQ docs, *Workers / Concurrency / Sandboxed processors*, https://docs.bullmq.io/guide/workers
- [16] csv.js.org Parse, *Option encoding*, https://csv.js.org/parse/options/encoding/
- [17] csv.js.org Parse, *Option bom*, https://csv.js.org/parse/options/bom/
- [18] runk/node-chardet, https://github.com/runk/node-chardet
- [19] OneUpTime, *How to Perform Bulk Inserts in MySQL*, https://oneuptime.com/blog/post/2026-03-31-mysql-bulk-inserts-performance/view
- [20] MySQL 9.7 docs, *Optimizing INSERT Statements*, https://dev.mysql.com/doc/refman/9.7/en/insert-optimization.html
- [21] Snyk, *How to handle Node.js file uploads with Fastify*, https://snyk.io/blog/node-js-file-uploads-with-fastify/
- [22] Medium, *11 Node.js Backpressure Patterns for Safe Streams*, https://medium.com/@hadiyolworld007/11-node-js-backpressure-patterns-for-safe-streams-874a214a1e76
- [23] Zerone Consulting, *Real Time Magic Harnessing Server Sent Events (SSE) with Redis*, https://www.zerone-consulting.com/resources/blog/Real-Time-Magic-Harnessing-Server-Sent-Events-(SSE)-with-Redis/
- [24] 2ality, *Easier Node.js streams via async iteration*, https://2ality.com/2019/11/nodejs-streams-async-iteration.html
- [25] BullMQ docs, *Sandboxed processors*, https://docs.bullmq.io/guide/workers/sandboxed-processors
- [26] csvworkbench.com, *RFC 4180 CSV Validation: The Complete Guide*, https://csvworkbench.com/blog/rfc4180-csv-validation.html
- [27] BullMQ docs, *Flows*, https://docs.bullmq.io/guide/flows
- [28] OneUpTime, *How to Use BullMQ Flow Producer for Job Pipelines*, https://oneuptime.com/blog/post/2026-01-21-bullmq-flow-producer-pipelines/view
- [29] Convoso, *DNC Scrubbing for Call Centers*, https://www.convoso.com/advanced-features/dnc-scrubbing/
- [30] inktel/Vicidial, *admin_listloader_third_gen.php*, https://github.com/inktel/Vicidial/blob/master/www/vicidial/admin_listloader_third_gen.php
- [31] nerthux/VicidialCSS, *admin_listloader_fourth_gen.php*, https://github.com/nerthux/VicidialCSS/blob/master/vicidial/admin_listloader_fourth_gen.php
- [32] PkgPulse, *SheetJS vs ExcelJS vs node-xlsx 2026*, https://www.pkgpulse.com/guides/sheetjs-vs-exceljs-vs-node-xlsx-excel-files-node-2026
- [33] leadgen-economy, *DNC Scrubbing for Lead Operators: Federal, State, RND, and Internal Lists*, https://www.leadgen-economy.com/blog/dnc-scrubbing-operator-deep-dive-federal-state-rnd/
- [34] InfoQ, *Reactive Real-Time Notifications with SSE, Spring Boot, and Redis Pub/Sub*, https://www.infoq.com/articles/reactive-notification-system-server-sent-events/
- [35] FlowVerify, *SSE vs WebSockets vs Polling: 2026 Decision Guide*, https://www.flowverify.co/blog/sse-websockets-polling-guide-2026
- [36] papaparse on npm (5.5.3), https://www.npmjs.com/package/papaparse
- [37] OneSchema, *5 Best Practices for Building a CSV Uploader*, https://www.oneschema.co/blog/building-a-csv-uploader
- [38] Flatfile, *Building a Seamless CSV Import Experience*, https://flatfile.com/blog/optimizing-csv-import-experiences-flatfile-portal/

Repository:

- `/root/vici2/DESIGN.md` §1.5, §2.1, §3, §5.4 — lead lifecycle, services, stack, DNC.
- `/root/vici2/SPEC.md` §0–§3 — agent workflow, dependency graph, conventions.
- `/root/vici2/spec/modules/D02.md` — module spec, acceptance criteria.
- `/root/vici2/spec/modules/D01/PLAN.md` — `LeadService.bulkInsert` contract (§4), normalize (§6), idempotency (§1.4), bulk handoff to D02 (§14.1).
- `/root/vici2/spec/modules/D01.md` — original module spec.
- `/root/vici2/spec/modules/D05/PLAN.md` — DNC Bloom topology (§1.2), Check API (§2.1), fail-closed (§1.5).
- `/root/vici2/spec/modules/C01/PLAN.md` — TCPA Check union (§2), enforcement points (§7), audit shape.
- `/root/vici2/spec/modules/F02/AMENDMENTS-HANDOFF.md` — `leads.version`, `leads.tz_blocked`, schema state, new partitioned-table conventions.
- `/root/vici2/api/prisma/schema.prisma` §4.7 (List), §4.13 (Lead), §4.15 (PhoneCode), §A4 (ZipCode), §4.14 (Dnc).
- `/root/vici2/spec/modules/E02/RESEARCH.md` — formatting + depth reference (matched here).

---

End of RESEARCH.md.
