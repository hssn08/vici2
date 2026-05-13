# W02 — Jobs Queue Admin UI — PLAN

| Field | Value |
|---|---|
| Module | W02 (Jobs Queue Admin UI, Phase 1) |
| Author | W02-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Status | PROPOSED — awaiting orchestrator/human review |
| Companion | [RESEARCH.md](./RESEARCH.md) |
| Depends on (FROZEN) | W01 (queue topology + DLQ contract), M01 (admin shell + RBAC patterns), O01 (Prometheus; informational), F05 (JWT + requirePermission) |
| Blocks | None (leaf module — admin tool only) |

This plan is the binding contract for the jobs queue admin UI. W02 adds Fastify API routes and Next.js admin pages to expose BullMQ queue state, job lifecycle management, and DLQ inspection to authorized operators. It does not modify the workers package, the BullMQ topology, or the DLQ stream format (all FROZEN by W01).

Once approved, the following are **FROZEN**: API route paths and response shapes, RBAC permission identifiers (`jobs:view`, `jobs:retry`, `jobs:drain`), DLQ entry retry protocol (Queue.add + XACK), the sensitive-data masking contract (mask by default, super_admin opt-in), and the Next.js page routing structure under `admin/src/app/(admin)/jobs/`. Internal implementation of API handlers, React components, and query hook factories may change without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **Custom native integration, not Bull-Board or Arena.** Bull-Board cannot enforce per-action RBAC (view vs retry vs drain), cannot write audit_log rows, cannot inspect Valkey stream DLQ entries, and renders as a foreign SPA incompatible with the `admin/` shell. Arena is abandoned-ware. Full rationale in RESEARCH §1-2.

2. **Eight API endpoints, two resource domains.** `/api/admin/jobs/queues/*` handles BullMQ queue and job operations using BullMQ's `Queue` programmatic API. `/api/admin/jobs/dlq/*` handles Valkey stream DLQ inspection using XRANGE/XACK. All endpoints are Fastify routes registered under the existing admin prefix with `requirePermission` middleware.

3. **Three-tier RBAC: jobs:view, jobs:retry, jobs:drain.** `jobs:view` (admin + supervisor + super_admin) allows listing queues and reading job details. `jobs:retry` (admin + super_admin) allows retry, remove, pause, and resume. `jobs:drain` (super_admin only) allows queue drain and DLQ drain. Permission names added to `shared/types/src/rbac.ts`.

4. **Audit on every mutation.** Retry, remove, pause, resume, drain, DLQ retry, and DLQ drain each write one `audit_log` row via the C03 audit helper. Actor (user_id), action (string), target (queue + optional job id), tenant_id, and ip_address are recorded. Read operations (GET) do not produce audit rows.

5. **Sensitive-data masking by default.** Job data fields matching NANP phone regex, email regex, or known PII key names (ssn, dob, credit_card) are replaced with `***REDACTED***` before the response leaves the API. A `super_admin` user may request unmasked data by including `X-Jobs-Unmask: 1` in the request; this is enforced server-side and itself produces an audit row.

6. **Next.js pages at `(admin)/jobs/`.** Queue index page, queue detail page (job list by state), job detail page, and DLQ page per queue. All live inside the M01 `AdminShell` layout — shared nav, dark mode, breadcrumb, accessibility. No iframe, no embedded Bull-Board SPA.

7. **Real-time via WS event subscription + 5-second polling fallback.** The queue index page subscribes to `events:vici2.bullmq.job.*` (published by the workers lib on each job lifecycle event). Queue counts update optimistically via TanStack Query cache invalidation. If WS drops, 5-second polling resumes automatically.

8. **Stream-based queues shown as read-only depth + consumer lag.** recording-log-writer and freeswitch-event-router use XREADGROUP, not BullMQ Queue API. Their "queue depth" is `XLEN`; their consumer lag is `XPENDING` count. No pause/resume button is shown. Drain is out of scope (CLI-only).

9. **Callback tick queues shown as lock-state read-only.** callback-fire/upcoming/stale use setInterval + Valkey advisory lock. The UI shows lock holder hostname+pid and lock TTL. Pause/resume of tick workers is deferred to Phase 2.

10. **DLQ retry = Queue.add() + XACK (two-step).** Re-enqueueing a DLQ entry creates a fresh BullMQ job via `Queue.add()`, then acknowledges the DLQ stream entry via `XACK`. For stream-based workers, replay inserts back into the source stream via `XADD`. The two-step is not transactional; the API documents this and the UI shows "retry requested" state.

---

## 1. Goals and Non-Goals

### 1.1 Goals

- Provide operators with complete visibility into all 11 BullMQ + stream + tick queues defined in W01.
- Allow authorized operators to retry failed jobs, remove stale jobs, pause/resume queues, and drain queues with appropriate RBAC gates.
- Allow authorized operators to inspect DLQ stream entries and replay (retry) individual entries or drain entire DLQ streams.
- Embed the jobs UI in the `admin/` Next.js shell — same nav, same auth, same design system, same accessibility.
- Write audit_log rows for every mutation.
- Mask PII in job.data by default; allow super_admin opt-in to view unmasked data.
- Support real-time queue state updates via WS with 5-second polling fallback.

### 1.2 Non-Goals (explicitly out of W02 scope)

- Modifying BullMQ queue topology, configuration, or DLQ stream format (FROZEN by W01).
- Implementing BullMQ Flow Producer / parent-child job chains (Phase 2).
- Pausing or resuming stream-based workers (recording-log-writer, freeswitch-event-router) — not semantically possible without scaling workers to 0 replicas.
- Pausing or resuming setInterval tick workers (callback-fire/upcoming/stale) — deferred to Phase 2 (requires sentinel logic in workers).
- Grafana/Prometheus dashboards for queue metrics — provided by O01.
- Bulk job retry across the entire failed set — deferred to Phase 2. Phase 1 retries one job at a time.
- Job search by data content — deferred to Phase 2 (requires ElasticSearch or SCAN with MATCH, expensive at scale).
- Email or Slack notifications when DLQ depth crosses a threshold — provided by O01 alert rules (W01 §9.4).
- The DLQ replay worker (automated; W01 §5.5) — this plan covers only the admin-initiated replay.
- Kubernetes manifests or horizontal scaling — owned by O04.

---

## 2. API Endpoints

All endpoints are registered under the Fastify admin router (existing prefix: `/api/admin`). All require `F05 requirePermission` middleware. All return JSON with `Content-Type: application/json`. Errors follow the standard Fastify error schema: `{ error: string; message: string; statusCode: number }`.

### 2.1 `GET /api/admin/jobs/queues`

**Permission:** `jobs:view`

**Purpose:** List all 11 queues (BullMQ + stream + tick) with current state counts.

**Implementation:** For each BullMQ queue, call `Queue.getJobCounts()` and `Queue.isPaused()`. For stream queues, call `XLEN` (depth) and `XPENDING` count (consumer group lag). For tick queues, call `EXISTS` + `TTL` on the lock key. All calls are parallelized via `Promise.all()`. Response is assembled server-side and returned as a single JSON object — no N+1 HTTP calls from the client.

**Response shape:**
```typescript
type QueueSummary = {
  name: string;              // "vici2:queue:lead-import"
  displayName: string;       // "Lead Import"
  kind: 'bullmq' | 'stream' | 'tick';
  owner: string;             // "D02"
  workerPackage: string;     // "@vici2/workers"
  isPaused: boolean | null;  // null for stream/tick kinds
  counts: {
    waiting: number | null;
    active: number | null;
    completed: number | null;
    failed: number | null;
    delayed: number | null;
    paused: number | null;
    // stream-kind fields:
    depth: number | null;    // XLEN
    pending: number | null;  // XPENDING count (consumer lag)
    // tick-kind fields:
    lockHeld: boolean | null;
    lockHolder: string | null;  // "hostname-pid"
    lockTtlMs: number | null;
  };
  dlqDepth: number;          // XLEN events:vici2.dlq.{worker}; 0 if no DLQ
};

type GetQueuesResponse = {
  queues: QueueSummary[];
  fetchedAt: string;  // ISO-8601
};
```

**Caching:** 5-second server-side cache (shared across all admin users for the same tenant). Cache key: `jobs:queueSummary:{tenantId}`. Valkey `SET EX 5`. Rationale: queue counts change frequently; stale-while-revalidate is acceptable; the WS subscription handles real-time deltas.

**Error handling:** If a single queue's `getJobCounts()` throws (e.g., Valkey connectivity issue), that queue's counts are filled with `null` and a `warning` field is added to the response. The endpoint returns 200, not 503 — partial data is more useful than a hard failure.

### 2.2 `GET /api/admin/jobs/queues/:queue/jobs`

**Permission:** `jobs:view`

**Query parameters:**
- `state`: `'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'` (required)
- `page`: integer ≥ 0, default 0 (BullMQ uses index-based pagination, not cursor)
- `pageSize`: integer 1–100, default 20
- `order`: `'asc' | 'desc'`, default `'desc'`

**Applicable queues:** BullMQ queues only. Returns 400 `{"error": "QUEUE_KIND_MISMATCH"}` for stream or tick queues.

**Implementation:** `await queue.getJobs([state], page * pageSize, (page + 1) * pageSize - 1, order === 'asc')`. Map each `Job` to a `JobSummary`.

**Response shape:**
```typescript
type JobSummary = {
  id: string;
  name: string;
  queue: string;
  state: string;
  attemptsMade: number;
  maxAttempts: number;
  timestamp: number;           // enqueue time (Unix ms)
  processedOn: number | null;
  finishedOn: number | null;
  delay: number;
  priority: number;
  failedReason: string | null; // job.failedReason (last error message)
  // job.data is OMITTED from list view (reduce payload size)
};

type GetJobsResponse = {
  jobs: JobSummary[];
  total: number;    // Queue.getJobCountByTypes(state)
  page: number;
  pageSize: number;
  state: string;
  queue: string;
};
```

**Note:** `job.data` and `job.returnvalue` are intentionally omitted from the list response. Fetching full job data for 20 jobs can be 100s of KB. Detail is available via the single-job endpoint.

### 2.3 `GET /api/admin/jobs/queues/:queue/jobs/:id`

**Permission:** `jobs:view`

**Purpose:** Full job detail including data, return value, stack trace, and logs.

**Implementation:** `await queue.getJob(id)`. If null, return 404. Apply sensitive-data masking (§5 below). Check `X-Jobs-Unmask: 1` header — if present, require `super_admin` role via F05, write unmask audit row, return unmasked data. Apply 64 KB truncation to `data` and `returnvalue` fields.

**Response shape:**
```typescript
type JobDetail = {
  id: string;
  name: string;
  queue: string;
  state: string;
  attemptsMade: number;
  maxAttempts: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  delay: number;
  priority: number;
  failedReason: string | null;
  stacktrace: string[];        // job.stacktrace (array of stacktrace strings per attempt)
  opts: Record<string, unknown>;  // job.opts (attempts, backoff, etc.)
  data: Record<string, unknown>;  // masked unless X-Jobs-Unmask
  returnvalue: unknown | null;    // masked unless X-Jobs-Unmask
  logs: string[];                 // Queue.getJobLogs(id).logs
  _dataTruncated: boolean;        // true if data > 64 KB before masking
  _returnvalueTruncated: boolean;
  _masked: boolean;               // true if masking was applied
};
```

### 2.4 `POST /api/admin/jobs/queues/:queue/jobs/:id/retry`

**Permission:** `jobs:retry`

**Purpose:** Retry a failed job (move from failed set back to waiting).

**Body:** Empty `{}` or no body.

**Implementation:**
1. `const job = await queue.getJob(id)`. Return 404 if not found.
2. Verify job is in `failed` state: `const state = await job.getState()`. Return 409 `{"error": "NOT_FAILED"}` if not in failed state.
3. `await job.retry('failed')`.
4. Write audit row: `{ action: 'jobs.retry', target: { queue, jobId: id }, actor: req.user.id, tenantId, ip }`.
5. Return 200 `{ jobId: id, state: 'waiting', queue }`.

**Idempotency:** BullMQ's `job.retry()` is idempotent — retrying an already-waiting job is a no-op (BullMQ returns without error). The API handler re-reads state after retry and returns the actual resulting state.

### 2.5 `DELETE /api/admin/jobs/queues/:queue/jobs/:id`

**Permission:** `jobs:retry`

**Purpose:** Remove a job from any state (completed, failed, waiting, delayed).

**Implementation:**
1. `const job = await queue.getJob(id)`. Return 404 if not found.
2. `await job.remove()`.
3. Write audit row: `{ action: 'jobs.remove', target: { queue, jobId: id }, actor, tenantId, ip }`.
4. Return 204 No Content.

**Safety:** `job.remove()` on an active job throws a BullMQ error (`ERR_ACTIVE_JOB`). The handler catches this and returns 409 `{"error": "JOB_ACTIVE", "message": "Cannot remove an active job. Wait for it to complete or fail first."}`.

### 2.6 `POST /api/admin/jobs/queues/:queue/pause`

**Permission:** `jobs:retry`

**Applicable queues:** BullMQ queues only. Returns 400 for stream/tick queues.

**Implementation:**
1. Check `await queue.isPaused()`. If already paused, return 200 `{ paused: true, queue }` (idempotent).
2. `await queue.pause()`.
3. Write audit row: `{ action: 'jobs.queue.pause', target: { queue }, actor, tenantId, ip }`.
4. Return 200 `{ paused: true, queue }`.

### 2.7 `POST /api/admin/jobs/queues/:queue/resume`

**Permission:** `jobs:retry`

**Applicable queues:** BullMQ queues only.

**Implementation:**
1. Check `await queue.isPaused()`. If not paused, return 200 `{ paused: false, queue }` (idempotent).
2. `await queue.resume()`.
3. Write audit row: `{ action: 'jobs.queue.resume', target: { queue }, actor, tenantId, ip }`.
4. Return 200 `{ paused: false, queue }`.

### 2.8 `POST /api/admin/jobs/queues/:queue/drain`

**Permission:** `jobs:drain`

**Applicable queues:** BullMQ queues only. Returns 400 for stream/tick queues.

**Query parameters:**
- `delayed`: `'true' | 'false'` (default `'false'`). If `'true'`, also drains the delayed set.

**Requires confirmation token:** The request body must include `{ "confirm": "drain {queue}" }` (exact string match). Return 400 `{"error": "CONFIRMATION_REQUIRED"}` if absent or mismatched.

**Implementation:**
1. Validate confirmation token.
2. `const delayed = req.query.delayed === 'true'`.
3. `await queue.drain(delayed)`.
4. Write audit row: `{ action: 'jobs.queue.drain', target: { queue, delayed }, actor, tenantId, ip }`.
5. Return 200 `{ drained: true, queue, delayed }`.

**Note:** `queue.drain()` removes all waiting (and optionally delayed) jobs. Active jobs are not affected. Completed/failed jobs in the removal window are not affected (they are in separate sorted sets). Document this in the UI confirmation dialog.

### 2.9 `GET /api/admin/jobs/dlq/:queue`

**Permission:** `jobs:view`

**Purpose:** List entries in the DLQ Valkey stream for a given queue/worker.

**Query parameters:**
- `cursor`: string, default `'-'` (Redis stream start token). For pagination, pass the last entry ID from previous response.
- `count`: integer 1–100, default 20
- `order`: `'asc' | 'desc'`, default `'desc'`. Desc = newest first (XREVRANGE); asc = oldest first (XRANGE).

**Implementation:**
1. Resolve stream name: `events:vici2.dlq.{queue}` (validate `:queue` is in the FROZEN worker list from W01 §5.1).
2. `const entries = await redis.xrange(stream, cursor, '+', 'COUNT', count)` (or `xrevrange` for desc).
3. `const total = await redis.xlen(stream)`.
4. Map each entry to `DlqEntrySummary`.

**Response shape:**
```typescript
type DlqEntrySummary = {
  entryId: string;           // Redis stream entry ID (e.g., "1715123456789-0")
  ts: number;                // Milliseconds extracted from entry ID
  worker: string;
  sourceQueue: string;
  sourceId: string;          // Original BullMQ job ID or stream entry ID
  payload: Record<string, unknown>;  // Parsed JSON; masked unless X-Jobs-Unmask
  error: string;
  errorStack: string;
  attempt: number;
  workerId: string;          // hostname-pid that wrote the DLQ entry
  tenantId: string;
  _masked: boolean;
};

type GetDlqResponse = {
  entries: DlqEntrySummary[];
  total: number;             // XLEN of the stream
  queue: string;
  streamName: string;
  nextCursor: string | null; // null = end of stream
};
```

### 2.10 `POST /api/admin/jobs/dlq/:queue/:entry-id/retry`

**Permission:** `jobs:retry`

**Purpose:** Replay a single DLQ entry by re-enqueueing it to the source queue and acknowledging the DLQ stream entry.

**Implementation — BullMQ-queued workers (lead-import, recording-upload, recording-delete-local, audit-attest, federal-dnc-sync, state-dnc-sync):**
1. `const [entryId, fields] = await redis.xrange(dlqStream, entryId, entryId)`. Return 404 if not found.
2. Parse `fields.payload` as JSON.
3. Resolve the target `Queue` instance from `fields.source_queue`.
4. `const newJobId = ulid()`.
5. `await targetQueue.add(fields.worker, parsedPayload, { jobId: newJobId, ...defaultOptsForWorker })`.
6. Write audit row: `{ action: 'jobs.dlq.retry', target: { dlqStream, entryId, newJobId }, actor, tenantId, ip }`.
7. `await redis.xack(dlqStream, 'dlq-admin', entryId)`. (Note: DLQ streams do not have consumer groups by default — W01 uses bare XADD. Therefore XACK is not applicable. Instead, use `XDEL dlqStream entryId` to remove the replayed entry.)
8. Return 200 `{ retried: true, newJobId, entryId }`.

**Correction (XACK vs XDEL):** W01's DlqWriter uses bare `XADD` without a consumer group. There is no XREADGROUP consumer group on the DLQ stream. Therefore "acknowledging" a replayed entry means `XDEL events:vici2.dlq.{worker} {entryId}`. This is permanent removal from the stream. Document this clearly in the UI: "Retrying removes this entry from the DLQ permanently."

**Implementation — stream-based workers (recording-log-writer, freeswitch-event-router):**
1. Same steps 1-2 to retrieve payload.
2. Resolve the source stream name from `fields.source_queue`.
3. `await redis.xadd(sourceStream, '*', ...flattenedPayloadFields)`. Re-inserts the event into the source stream so the XREADGROUP consumer picks it up.
4. `await redis.xdel(dlqStream, entryId)`.
5. Write audit row.
6. Return 200.

### 2.11 `DELETE /api/admin/jobs/dlq/:queue`

**Permission:** `jobs:drain`

**Purpose:** Drain (empty) the entire DLQ stream for a queue.

**Requires confirmation token:** Body must include `{ "confirm": "drain dlq {queue}" }`.

**Implementation:**
1. Validate confirmation token.
2. `const count = await redis.xlen(dlqStream)`.
3. `await redis.xtrim(dlqStream, 'MAXLEN', 0)` (equivalent to DEL but preserves the stream key).
4. Write audit row: `{ action: 'jobs.dlq.drain', target: { dlqStream, entriesRemoved: count }, actor, tenantId, ip }`.
5. Return 200 `{ drained: true, entriesRemoved: count, queue }`.

**Why XTRIM instead of DEL:** `XTRIM stream MAXLEN 0` removes all entries but preserves the stream key and any consumer group definitions that might be added later. `DEL` requires re-creating the stream and consumer groups on the next XADD. Since W01's DLQ streams have no consumer groups currently, either works — XTRIM is the safer habit.

---

## 3. RBAC

### 3.1 Permission definitions (to add to `shared/types/src/rbac.ts`)

```typescript
// Addition to the permissions union type:
type Permission =
  | ... // existing permissions
  | 'jobs:view'    // List queues, list jobs, view job detail, view DLQ entries
  | 'jobs:retry'   // Retry job, remove job, pause queue, resume queue, retry DLQ entry
  | 'jobs:drain';  // Drain queue, drain DLQ (super_admin only)

// Role → permission assignments (additive to existing matrix):
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: [...existing, 'jobs:view', 'jobs:retry', 'jobs:drain'],
  admin:       [...existing, 'jobs:view', 'jobs:retry'],
  supervisor:  [...existing, 'jobs:view'],
  agent:       [...existing],  // no jobs permissions
};
```

### 3.2 Endpoint permission matrix

| Endpoint | Required permission | Notes |
|---|---|---|
| GET /queues | `jobs:view` | |
| GET /queues/:q/jobs | `jobs:view` | |
| GET /queues/:q/jobs/:id | `jobs:view` | `X-Jobs-Unmask: 1` additionally requires `super_admin` role check |
| POST /queues/:q/jobs/:id/retry | `jobs:retry` | |
| DELETE /queues/:q/jobs/:id | `jobs:retry` | |
| POST /queues/:q/pause | `jobs:retry` | |
| POST /queues/:q/resume | `jobs:retry` | |
| POST /queues/:q/drain | `jobs:drain` | |
| GET /dlq/:q | `jobs:view` | |
| POST /dlq/:q/:eid/retry | `jobs:retry` | |
| DELETE /dlq/:q | `jobs:drain` | |

### 3.3 Frontend CASL enforcement

The `<Can do="jobs:drain" on="Queue" />` component from `@vici2/auth` hides the Drain button for non-super_admin users. The Retry button uses `<Can do="jobs:retry" on="Queue" />`. Read-only users (supervisors) see queue counts and job details but all action buttons are absent from the DOM (not just disabled — absent, per RESEARCH accessibility guidance).

---

## 4. Audit Contract

Every mutation endpoint writes one `audit_log` row via the `auditLog.write()` helper (pattern established by C03). The audit row schema:

```typescript
type JobsAuditEntry = {
  user_id: number;
  action: string;   // e.g., 'jobs.retry', 'jobs.queue.drain', 'jobs.dlq.drain', 'jobs.unmask'
  target_type: string;    // 'job' | 'queue' | 'dlq' | 'dlq_entry'
  target_id: string;      // queue name + optional job/entry ID
  target_meta: Record<string, unknown>;  // additional context (e.g., { delayed: true })
  tenant_id: number;
  ip_address: string;     // from X-Forwarded-For or req.ip
  created_at: Date;
};
```

**Action identifiers (FROZEN):**

| API action | Audit action string |
|---|---|
| POST retry | `jobs.retry` |
| DELETE job | `jobs.remove` |
| POST pause | `jobs.queue.pause` |
| POST resume | `jobs.queue.resume` |
| POST drain | `jobs.queue.drain` |
| GET job with X-Jobs-Unmask | `jobs.unmask` |
| POST dlq/:q/:eid/retry | `jobs.dlq.retry` |
| DELETE dlq/:q | `jobs.dlq.drain` |

Read operations (GET) do not produce audit rows.

---

## 5. Sensitive-Data Masking

### 5.1 Masking rules (applied server-side before API response)

The masking function (`maskJobData(data: unknown): unknown`) is applied to `job.data` and `job.returnvalue` in all API responses unless the `X-Jobs-Unmask: 1` header is present and the user has `super_admin` role.

**Masked value patterns:**
- Any string field value matching NANP phone regex: `/^[+]?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/`
- Any string field value matching email regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- Any field whose key name (case-insensitive) matches: `ssn`, `social_security`, `dob`, `date_of_birth`, `credit_card`, `pan`, `card_number`

**Replacement value:** `"***REDACTED***"` (string, regardless of original type for PII key names).

**Deep traversal:** The function recursively traverses nested objects and arrays. Array elements are individually masked.

**64 KB truncation:** After masking, if `JSON.stringify(data).length > 65_536`, the data is replaced with `{ _truncated: true, _message: "Field exceeds 64 KB limit. Use CLI tools for full inspection." }`. The `_dataTruncated: true` flag is set on the response envelope.

### 5.2 Unmask flow

```
Client sends GET /api/admin/jobs/queues/:q/jobs/:id
  with header X-Jobs-Unmask: 1
  with valid sx_user JWT (super_admin role)
→ API handler: checks req.user.role === 'super_admin'; returns 403 if not
→ API handler: skips masking; returns full job.data
→ API handler: writes audit row { action: 'jobs.unmask', target: { queue, jobId: id } }
→ Response: { ..., _masked: false }
```

The `X-Jobs-Unmask` header is stripped by the admin Next.js middleware before forwarding to external networks (defense in depth). It only works in the server-side API call path.

---

## 6. Web UI

### 6.1 Page routing structure

```
admin/src/app/(admin)/jobs/
├── page.tsx                          ← Queue index (all 11 queues, state counts, DLQ depth badge)
├── layout.tsx                        ← Adds "Jobs" to breadcrumb; no new layout wrapper needed
├── [queue]/
│   ├── page.tsx                      ← Queue detail (job list; state tabs; pause/resume/drain)
│   └── jobs/
│       └── [id]/
│           └── page.tsx              ← Job detail (data + stacktrace + logs + retry/remove)
└── dlq/
    └── [queue]/
        └── page.tsx                  ← DLQ inspect (entry list; retry single; drain all)
```

### 6.2 Queue index page (`(admin)/jobs/page.tsx`)

**Component:** `JobsQueueIndex` (server component, data fetched via RSC using the `@vici2/api-client`)

**Layout:** A responsive card grid (3 columns on 1280px+; 2 on 768px; 1 on mobile). Each card:
- Queue display name + kind badge (`BullMQ` / `Stream` / `Tick`)
- Owner module badge (D02, R01, etc.)
- State count pills: waiting (blue), active (green), failed (red), delayed (yellow). Stream queues show depth + pending. Tick queues show lock state chip.
- DLQ depth badge (red dot if > 0)
- Pause state indicator (paused icon if isPaused)
- Link to queue detail page

**Real-time:** The client component `<QueueIndexLive>` wraps the static server-rendered grid. On mount, it subscribes to WS topic `t:{tenantId}:bullmq:counts` (see §7). On WS message, it updates the count pills via React state. On WS disconnect, it falls back to 5-second `refetchInterval` in TanStack Query.

**Admin sidebar entry:** Add `{ key: 'jobs', label: 'Job Queues', href: '/jobs', icon: 'layers', requires: { action: 'jobs:view', subject: 'Queue' } }` to `admin/src/lib/nav-config.ts`.

### 6.3 Queue detail page (`(admin)/jobs/[queue]/page.tsx`)

**Tabs:** Waiting | Active | Completed | Failed | Delayed | (Paused if isPaused). Default tab: Failed.

**Job list:** `<OffsetTable>` from `packages/ui` with columns: Job ID, Name, Attempts, Enqueued At, Processed At, Finished At, Failed Reason (truncated 80 chars). Click row → navigate to job detail page.

**Actions bar (above table):**
- `<Can do="jobs:retry" on="Queue">` → Pause / Resume button (toggle based on isPaused state)
- `<Can do="jobs:drain" on="Queue">` → Drain button (opens confirmation dialog with typed-confirmation input)
- Refresh button (manual refetch)

**Stream queue detail:** For stream/tick kinds, the tab structure is replaced with a simple stat card showing depth, pending, and consumer list (from `XINFO GROUPS stream`). No job list — individual stream entries are not paginated in Phase 1 (too large and not individually addressable by ID in the same way).

**DLQ link:** If `dlqDepth > 0`, show a red-badged "View DLQ" button linking to `/jobs/dlq/{queue}`.

### 6.4 Job detail page (`(admin)/jobs/[queue]/jobs/[id]/page.tsx`)

**Layout:**
- Page header: Job ID (monospace) + state badge + queue name breadcrumb
- Two-column grid (1 col on mobile):
  - Left: Job metadata card (timestamps, attempts, delay, priority, opts)
  - Right: Actions card (Retry button if failed; Remove button; Unmask toggle for super_admin)
- Full-width: Job Data section (syntax-highlighted JSON via `react-json-view` or equivalent shadcn-compatible viewer). Shows `***REDACTED***` strings with a redaction badge. Super_admin sees Unmask toggle.
- Full-width: Stacktrace section (collapsible; one accordion panel per attempt). Each panel shows the stacktrace string.
- Full-width: Job Logs section (chronological list from `queue.getJobLogs()`).

**Unmask flow (client-side):** Super_admin users see an eye-icon toggle. Clicking it calls `GET /api/admin/jobs/queues/:q/jobs/:id` with `X-Jobs-Unmask: 1`. The page re-renders with unmasked data. A sonner toast confirms: "Viewing unmasked job data. This action is audited."

### 6.5 DLQ inspect page (`(admin)/jobs/dlq/[queue]/page.tsx`)

**Layout:**
- Page header: "DLQ: {displayName}" + stream name in small text + `XLEN` count badge
- Warning callout: "Dead-letter queue entries represent jobs that failed all retry attempts. Retrying an entry creates a new BullMQ job and removes the entry permanently."
- DLQ entry table with columns: Entry ID, Timestamp, Worker, Source Queue, Source ID, Error (truncated), Attempts, Worker ID, Tenant
- Row expand: Click row to expand inline detail showing `payload` (masked JSON) + full `error_stack`
- Per-row action: Retry button (`<Can do="jobs:retry" on="Queue">`)
- Page action: Drain All button (`<Can do="jobs:drain" on="Queue">`) with typed-confirmation dialog

**Pagination:** "Load more" button (not infinite scroll). Passes `cursor` = last entry ID to `GET /api/admin/jobs/dlq/:queue?cursor=...&order=desc`.

---

## 7. Real-Time State

### 7.1 WS topic design

Workers publish lightweight lifecycle events to a Redis Stream: `events:vici2.bullmq.jobs` with fields:
```
XADD events:vici2.bullmq.jobs MAXLEN ~ 1000 *
  queue       "vici2:queue:lead-import"
  event       "completed"   # or "failed" | "active" | "waiting"
  jobId       "01JEX..."
  tenantId    "1"
  ts          "1715123456789"
```

The API's WS broadcast worker (existing infrastructure from F05/A01) subscribes to `events:vici2.bullmq.jobs` and fans out to connected admin clients on topic `t:{tenantId}:bullmq:counts`.

### 7.2 Client subscription

```typescript
// admin/src/app/(admin)/jobs/_components/QueueIndexLive.tsx
// 'use client'

const { data: queues } = useQuery({
  queryKey: ['jobs', 'queues', tenantId],
  queryFn: () => apiClient.GET('/api/admin/jobs/queues'),
  refetchInterval: wsConnected ? false : 5_000,  // 5s polling when WS down
});

useWsSubscription(`t:${tenantId}:bullmq:counts`, (msg) => {
  // Invalidate the queues query to trigger refetch
  queryClient.invalidateQueries({ queryKey: ['jobs', 'queues', tenantId] });
});
```

The WS event does not carry full queue counts (those require N Queue API calls to assemble). Instead, the event triggers a TanStack Query cache invalidation that causes a background refetch of the full counts. This refetch uses the 5-second server-side cache, so rapid job completions do not DDoS the Valkey queue API.

### 7.3 Worker-side publish requirement

**Amendment request to W01 IMPLEMENT:** Add the following to `workers/src/lib/metrics.ts` in `setupWorkerMetrics()`:

```typescript
// After existing completed/failed event handlers:
worker.on('completed', async (job) => {
  await redis.xadd(
    'events:vici2.bullmq.jobs', 'MAXLEN', '~', '1000', '*',
    'queue', queueName,
    'event', 'completed',
    'jobId', job.id ?? '',
    'tenantId', String((job.data as any)?.tenantId ?? '0'),
    'ts', String(Date.now()),
  );
});

worker.on('failed', async (job, _err) => {
  if (!job) return;
  await redis.xadd(
    'events:vici2.bullmq.jobs', 'MAXLEN', '~', '1000', '*',
    'queue', queueName,
    'event', 'failed',
    'jobId', job.id ?? '',
    'tenantId', String((job.data as any)?.tenantId ?? '0'),
    'ts', String(Date.now()),
  );
});
```

If W01 IMPLEMENT is already complete, W02 IMPLEMENT adds these lines as an amendment PR against `workers/src/lib/metrics.ts`.

---

## 8. Files to Create

### 8.1 API routes (`api/src/routes/admin/jobs/`)

```
api/src/routes/admin/jobs/
├── index.ts                  ← Register all W02 routes on the admin Fastify plugin
├── queues.ts                 ← GET /queues handler
├── queue-jobs.ts             ← GET /queues/:q/jobs + GET /queues/:q/jobs/:id handlers
├── queue-actions.ts          ← POST pause | resume | drain; DELETE job; POST job retry handlers
├── dlq.ts                    ← GET /dlq/:q; POST /dlq/:q/:eid/retry; DELETE /dlq/:q handlers
├── lib/
│   ├── queue-registry.ts     ← Singleton: Map<string, Queue> + Map<string, string> (stream names)
│   │                            Lazily instantiates BullMQ Queue instances (read-only, no Worker)
│   ├── queue-meta.ts         ← Static metadata for all 11 queues (displayName, kind, owner, etc.)
│   ├── mask-job-data.ts      ← maskJobData(data) → masked data; isRedacted flag
│   └── audit-jobs.ts         ← Typed wrappers around the shared auditLog.write() helper
```

**Queue registry design:** BullMQ `Queue` instances (not `Worker` instances) are lightweight and safe to create in the API process. They hold a Valkey connection and expose the read/write API without consuming jobs. The registry creates one `Queue` per BullMQ queue on first request and reuses them. Stream and tick queues use the shared ioredis client directly (no BullMQ Queue instance needed).

### 8.2 Next.js pages (`admin/src/app/(admin)/jobs/`)

```
admin/src/app/(admin)/jobs/
├── page.tsx                              ← JobsQueueIndexPage (Server Component)
├── layout.tsx                            ← Breadcrumb: Admin > Jobs
├── _components/
│   ├── QueueCard.tsx                     ← Card for one queue in the index grid
│   ├── QueueIndexLive.tsx                ← 'use client'; WS subscription + polling
│   ├── QueueStatePill.tsx                ← Colored pill for state count
│   ├── QueueKindBadge.tsx                ← BullMQ / Stream / Tick badge
│   └── DlqDepthBadge.tsx                 ← Red badge for DLQ depth > 0
├── [queue]/
│   ├── page.tsx                          ← QueueDetailPage (Server Component)
│   ├── _components/
│   │   ├── QueueDetailHeader.tsx         ← Queue name + pause state + action buttons
│   │   ├── JobStateTabList.tsx           ← Tab navigation: Waiting/Active/Failed/etc.
│   │   ├── JobListTable.tsx              ← OffsetTable wrapper for job list
│   │   ├── PauseResumeButton.tsx         ← 'use client'; calls pause/resume API
│   │   ├── DrainQueueDialog.tsx          ← 'use client'; typed-confirmation dialog
│   │   └── StreamQueueStats.tsx          ← Read-only stats for stream/tick queues
│   └── jobs/
│       └── [id]/
│           ├── page.tsx                  ← JobDetailPage (Server Component)
│           └── _components/
│               ├── JobMetaCard.tsx       ← Timestamps, attempts, opts
│               ├── JobActionsCard.tsx    ← Retry + Remove buttons; Unmask toggle
│               ├── JobDataViewer.tsx     ← 'use client'; JSON viewer with redaction highlights
│               ├── JobStacktrace.tsx     ← Accordion per attempt
│               └── JobLogs.tsx           ← Chronological log list
└── dlq/
    └── [queue]/
        ├── page.tsx                      ← DlqInspectPage (Server Component)
        └── _components/
            ├── DlqEntryTable.tsx         ← Cursor-paginated table
            ├── DlqEntryRow.tsx           ← Expandable row with payload + stacktrace
            ├── DlqRetryButton.tsx        ← 'use client'; single-entry retry
            └── DlqDrainDialog.tsx        ← 'use client'; typed-confirmation drain
```

### 8.3 Shared package additions

```
packages/api-client/src/schemas/
└── jobs.ts               ← Zod schemas for QueueSummary, JobSummary, JobDetail, DlqEntrySummary,
                             GetQueuesResponse, GetJobsResponse, GetDlqResponse,
                             RetryJobRequest, DrainQueueRequest, DrainDlqRequest

packages/api-client/src/react-query/hooks/
└── use-jobs.ts           ← useQueues(), useQueueJobs(), useJobDetail(), useDlqEntries()
                             query hook factories with typed keys + invalidation helpers
```

### 8.4 Shared types addition

```
shared/types/src/rbac.ts   ← ADD 'jobs:view' | 'jobs:retry' | 'jobs:drain' to Permission union
                              ADD per-role assignments (see §3.1)
```

---

## 9. Test Plan

### 9.1 Unit tests (`api/src/routes/admin/jobs/__tests__/`)

| Test file | Coverage |
|---|---|
| `mask-job-data.test.ts` | Phone/email/key masking; deep traversal; 64 KB truncation; no-mask passthrough |
| `queue-registry.test.ts` | Singleton behavior; lazy instantiation; unknown queue returns 400 |
| `queues.handler.test.ts` | GET /queues: all kinds returned; partial failure returns 200 with null counts |
| `queue-jobs.handler.test.ts` | GET jobs by state; 404 for unknown job; state filter enforced |
| `job-detail.handler.test.ts` | Masked response; X-Jobs-Unmask with super_admin; X-Jobs-Unmask rejected for non-super_admin; _dataTruncated flag |
| `queue-actions.handler.test.ts` | retry idempotency; remove active job → 409; pause already-paused → 200; drain missing confirm → 400; drain with correct confirm → 200 |
| `dlq.handler.test.ts` | XRANGE pagination; entryId not found → 404; XDEL called on retry; XTRIM called on drain; drain missing confirm → 400 |
| `audit-jobs.test.ts` | Each mutation action writes correct audit row; read actions write no row |

Test infrastructure: Vitest + `ioredis-mock` for Redis + `vitest-mock-extended` for BullMQ Queue instances.

### 9.2 Integration tests (`api/src/routes/admin/jobs/__tests__/integration/`)

| Test | Coverage |
|---|---|
| `rbac.test.ts` | supervisor can GET /queues but POST /drain returns 403; agent returns 401 |
| `queue-lifecycle.test.ts` | End-to-end: enqueue job → verify in waiting → pause queue → verify isPaused → resume → verify unpaused |
| `dlq-retry.test.ts` | Write DLQ entry → retry via API → verify new BullMQ job created → verify XDEL removed entry |

Integration tests use a real ioredis connection to a test Valkey instance (docker-compose test profile) and a real BullMQ Queue instance against the test queue `vici2:queue:test-jobs`.

### 9.3 E2E tests (`admin/playwright/e2e/jobs/`)

| Test | Coverage |
|---|---|
| `queue-index.spec.ts` | Admin can see queue index; queue cards show correct state counts; DLQ badge visible |
| `job-detail.spec.ts` | Click job row → navigate to detail; retry button visible; retry success toast; remove success |
| `rbac-supervisor.spec.ts` | Supervisor sees queue cards but Pause/Drain buttons absent; retry button absent |
| `rbac-super-admin.spec.ts` | super_admin sees all buttons including Drain; Unmask toggle visible |
| `drain-confirmation.spec.ts` | Drain dialog requires typed confirmation; wrong string → button disabled; correct string → success |
| `dlq-inspect.spec.ts` | DLQ page shows entries; expand row shows payload (redacted); retry removes entry from list |
| `dlq-drain.spec.ts` | super_admin can drain DLQ; supervisor drain button absent |
| `unmask.spec.ts` | super_admin: Unmask toggle → JSON viewer shows real phone number; sonner toast appears |

E2E tests use Playwright + MSW for API mocking in the Next.js test environment.

### 9.4 Accessibility

`admin/playwright/e2e/jobs/a11y.spec.ts` runs `@axe-core/playwright` on all 4 page types (queue index, queue detail, job detail, DLQ inspect) and asserts zero AA violations. Tab order through the action buttons must follow DOM order (queue cards → state tabs → job table → action buttons).

---

## 10. Acceptance Criteria

| # | Criterion | Tested by |
|---|---|---|
| 1 | `GET /api/admin/jobs/queues` returns all 11 queues with correct `kind` values | unit: `queues.handler.test.ts` |
| 2 | `GET /api/admin/jobs/queues` returns 200 (not 500) even if one queue's Redis call fails | unit: `queues.handler.test.ts` partial-failure test |
| 3 | `jobs:view`-only user (supervisor) cannot call POST or DELETE endpoints (returns 403) | integration: `rbac.test.ts` |
| 4 | `jobs:drain` endpoints return 403 for `admin` role (not super_admin) | integration: `rbac.test.ts` |
| 5 | Retry a failed job: job moves from `failed` to `waiting` state; audit row written | integration: `queue-lifecycle.test.ts` |
| 6 | Drain queue: requires exact confirmation string; success removes waiting jobs | unit: `queue-actions.handler.test.ts` |
| 7 | DLQ retry: new BullMQ job created; DLQ XDEL called; audit row written | integration: `dlq-retry.test.ts` |
| 8 | Phone numbers in `job.data` are masked as `***REDACTED***` in all GET responses for non-super_admin | unit: `mask-job-data.test.ts`, `job-detail.handler.test.ts` |
| 9 | `X-Jobs-Unmask: 1` from non-super_admin returns 403 | unit: `job-detail.handler.test.ts` |
| 10 | `X-Jobs-Unmask: 1` from super_admin returns unmasked data and writes audit row | unit + e2e: `unmask.spec.ts` |
| 11 | Queue index page renders all queue cards; DLQ depth badge visible when dlqDepth > 0 | e2e: `queue-index.spec.ts` |
| 12 | Drain button absent from DOM for supervisor users (not hidden, absent) | e2e: `rbac-supervisor.spec.ts` |
| 13 | All 4 page types pass `@axe-core/playwright` AA with zero violations | e2e: `a11y.spec.ts` |
| 14 | WS disconnect triggers 5s polling refetch (queue counts update within 10s of job event) | e2e: `queue-index.spec.ts` with WS disconnect simulation |
| 15 | `job.data` > 64 KB is truncated; `_dataTruncated: true` in response | unit: `mask-job-data.test.ts` |

---

## 11. Dependencies and Risks

### 11.1 Hard dependencies

| Dependency | Status | Notes |
|---|---|---|
| W01 PLAN frozen (queue names, DLQ stream names) | FROZEN | Queue names and DLQ stream names are fixed; W02 IMPLEMENT must use them verbatim |
| M01 IMPLEMENT: `admin/` Next.js shell exists | Required before W02 UI | W02 API routes can be built independently; W02 UI requires AdminShell layout |
| F05 IMPLEMENT: `requirePermission` middleware | Required before any API work | Without this, RBAC cannot be enforced |
| `shared/types/src/rbac.ts` updated with `jobs:*` permissions | Required | W02-PLAN requests this; F05 or M02 IMPLEMENT must add it |
| ioredis client available in the `api` Fastify instance | Assumed available | W01's DLQ pattern uses ioredis; the API must share the same Valkey connection pool |

### 11.2 Soft dependencies (nice-to-have before W02 IMPLEMENT)

| Dependency | Notes |
|---|---|
| W01 IMPLEMENT complete (workers running) | W02 API routes can be tested against a real Valkey queue even if workers are not running; empty queues are valid |
| O01 Grafana dashboards deployed | Not required; W02 UI is the operational complement (Grafana = historical; W02 = live action) |
| C03 IMPLEMENT: audit_log table + auditLog.write() helper | If C03 is not done, W02 IMPLEMENT stubs audit writes with a no-op logger and adds a TODO comment |

### 11.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BullMQ API change (`Queue.getJobs()` signature changes in 5.x → 6.x) | Low | Medium | Pin BullMQ version in `workers/package.json`; W02 IMPLEMENT should verify against pinned version. Queue programmatic API is stable |
| Large failed set ZRANGE scan blocks Redis event loop | Medium (high-traffic deployments) | Medium | Default pageSize 20; add warning if `failed` count > 10,000 suggesting CLI for bulk ops |
| `job.data` contains deeply nested PII not caught by masking regexes | Medium | High | Document the masking scope explicitly; train operators that the Unmask toggle is audited; future Phase 2 can add field-name allowlisting |
| W01 IMPLEMENT already complete and `workers/src/lib/metrics.ts` does not publish WS events | Medium | Low | 5-second polling fallback covers this; WS event publishing is an enhancement |
| M01 IMPLEMENT delayed (no admin shell) | Medium | High | API routes can be built and tested in isolation; block W02 UI-IMPLEMENT on M01 merge |
| DLQ XDEL is not transactional with Queue.add() | Always true | Low | Document the two-step clearly; if Queue.add() fails, the DLQ entry is NOT deleted (safe: entry remains for next retry attempt). If XDEL fails after Queue.add(), a duplicate job exists (safe: BullMQ `jobId` dedup prevents double-processing if idempotency key is passed) |
| Confirmation token typed-confirmation UX adds friction | Design choice | None | Required for super_admin drain ops. Acceptable UX tradeoff given the destructive nature of drain |

---

*End of W02 PLAN*
