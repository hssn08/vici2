# W02 — Jobs Queue Admin UI — RESEARCH

| Field | Value |
|---|---|
| Module | W02 (Jobs Queue Admin UI, Phase 1) |
| Author | W02-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Status | RESEARCH — companion to PLAN.md |
| Depends on | W01 (queue topology), M01 (admin shell), O01 (Prometheus), F05 (JWT/RBAC) |

---

## 1. BullMQ Admin Landscape

### 1.1 Option A: Bull-Board (official `@bull-board/...`)

**What it is:** A community-standard admin UI for BullMQ (and the older Bull library). Maintained by the Felixmosh org; widely adopted. Provides Express/Fastify/Hapi adapters plus a standalone React app.

**Pros:**
- Production-tested across thousands of deployments.
- Rich feature set out of the box: queue list, job state tabs (waiting/active/completed/failed/delayed), job detail modal (data + stacktrace + logs), retry button, remove button, pause/resume queue, clean queue (drain by state), search, pagination.
- `@bull-board/fastify` integrates directly as a Fastify plugin — zero manual endpoint writing.
- Updated regularly alongside BullMQ releases; API compatibility is maintained.
- Low implementation cost: ~2 hours to mount and configure.

**Cons:**
- Renders as a completely separate React SPA, delivered from the Fastify plugin. Integration into the `admin/` Next.js app requires either:
  - An iframe pointing at `http://api:3000/bull-board/` — the "embed" anti-pattern. The UI lives in a foreign frame with no shared nav, no shared auth, no RBAC enforcement at the UI level (only at the mount guard), no shared design tokens, no accessible navigation.
  - OR repackaging the internal Bull-Board client bundle, which is unsupported.
- **No SSO integration.** Bull-Board has no concept of sessions or JWTs. The Fastify adapter allows mounting a guard (e.g., `preHandler` hook), but the actual UI displays no user identity and cannot enforce per-action RBAC (retry vs drain vs view-only). A super_admin and a supervisor both see the same UI once the guard passes.
- **No audit trail.** Bull-Board executes BullMQ operations directly — no hook point for writing `audit_log` rows via the C03 service. Audit requires wrapping every Bull-Board action endpoint, which is architecturally equivalent to writing the endpoints yourself.
- **No sensitive-data masking.** `job.data` may contain full NANP phone numbers, lead PII, file paths with tenant identifiers. Bull-Board renders raw JSON with no masking toggle.
- Design diverges permanently from the `admin/` shell. Every layout change, dark-mode update, or accessibility fix to the admin shell must be manually replicated to the iframe context — and cannot be, since Bull-Board's source is not part of the monorepo.
- Uses the older Bull (v3) API in some fallback paths; BullMQ compatibility requires `@bull-board/bullmq` adapter, adding a second dependency layer.

**Verdict for vici2:** Acceptable for a pure internal debug tool with a single admin user and no audit/RBAC requirements. Not acceptable for vici2's Phase 1 operator console, which has F05-backed SSO, M02-managed RBAC (jobs:view/retry/drain), C03 audit, and a compliance surface.

### 1.2 Option B: Arena

**What it is:** An older, less maintained Bull/BullMQ admin UI. Last meaningful update: 2022. Requires a separate Node process or Express mount.

**Pros:**
- Simple setup; well-documented.
- Supports BullMQ via a compatibility shim.

**Cons (in addition to all Bull-Board cons):**
- Maintenance burden: the project has gone dormant. Issues with BullMQ 5.x compatibility have been open for 12+ months with no resolution.
- Standalone process model: requires a separate container/port in docker-compose, further fragmenting the operational footprint.
- No Fastify adapter; requires Express middleware mount or a separate service.
- Same iframe-or-repackage dilemma as Bull-Board, with worse long-term support odds.
- No RBAC, no audit, no PII masking — same structural problems as Bull-Board, with less community momentum behind them.

**Verdict for vici2:** Eliminated. Bull-Board is strictly superior in both features and maintenance posture. Arena is not a contender.

### 1.3 Option C: Custom native integration (chosen)

**What it is:** A thin set of Fastify routes in `api/src/routes/admin/jobs/` backed directly by BullMQ's `Queue` class API, plus Next.js pages in `admin/src/app/(admin)/jobs/`. No third-party admin SPA involved.

**Pros:**
- **Native SSO via F05:** Every request is authenticated via the same `sx_user` cookie + `requirePermission` Fastify middleware that guards all other admin routes. No secondary auth surface.
- **Native RBAC via M02 patterns:** `jobs:view` (admin+supervisor), `jobs:retry` (admin), `jobs:drain` (super_admin). Implemented via F05's `requirePermission` middleware, not a custom guard. The CASL Ability in the Next.js `<Can>` component hides affordances that the backend also enforces.
- **Native audit via C03:** Every retry/drain/pause/resume action writes an `audit_log` row. Audit is first-class, not bolted on.
- **Embedded in admin shell:** The jobs pages live inside `admin/src/app/(admin)/jobs/` under the same `AdminShell` layout (sidebar, top-bar, breadcrumb, dark mode, responsive). No iframe. Screen reader users, keyboard nav users, and mobile users get the same experience as every other admin page.
- **Sensitive-data masking:** job.data fields matching phone-number patterns (NANP regex) and other PII (email, SSN prefix) are masked server-side before the response leaves the API. An admin opt-in toggle (`X-Jobs-Unmask: 1` header, RBAC-gated to super_admin) allows temporary inspection.
- **Real-time:** The admin pages subscribe to `events:vici2.bullmq.*` via the existing WebSocket infrastructure; no new event source needed.
- **DLQ inspect:** BullMQ's DLQ is implemented as Valkey streams (W01 §5). Bull-Board has no DLQ stream awareness at all — it only understands the BullMQ `failed` set. The custom layer reads `XRANGE events:vici2.dlq.*` natively and provides retry via `XADD` + `XACK`.
- **Stream-based queues (recording-log-writer, freeswitch-event-router):** These are not BullMQ queues in the traditional sense (W01 §2.2). Bull-Board cannot inspect them. The custom layer presents them with a consistent UX, differentiating their depth (XLEN) from BullMQ waiting counts.
- **Callback tick queues (callback-fire/upcoming/stale):** These are Valkey advisory lock + setInterval, not BullMQ queues. Bull-Board cannot see them at all. The custom layer exposes their lock key state (locked/unlocked) and last-tick timestamp from a Valkey scan.

**Cons:**
- Higher implementation cost: ~3-4 days vs 2 hours for Bull-Board mount.
- Must manually keep pace with BullMQ API changes (Queue.getJobs(), job.retry(), etc.) — though BullMQ's programmatic API is stable and changes are infrequent.
- Initial version lacks some Bull-Board conveniences (e.g., syntax-highlighted JSON diff viewer for job data across attempts). These are added in future iterations.

**Verdict for vici2:** Chosen. The audit, RBAC, SSO, DLQ-stream, and embedded-shell requirements make the custom approach the only viable long-term option. The upfront cost is bounded and the result is a first-class operator tool that fits seamlessly into the admin application.

---

## 2. Why Custom: Detailed Rationale

### 2.1 Native SSO via F05

Bull-Board's guard hook fires on mount — a single check at page load. If the session expires mid-session, Bull-Board has no mechanism to redirect to F05's refresh flow. The custom integration uses the same `401-retry.ts` client-side pattern as every other admin page (M01 PLAN §0.10 / `packages/api-client/src/401-retry.ts`), giving seamless token refresh without UX disruption.

F05 issues JWTs with `perms` claims. The jobs pages read permissions from the same `MeResponse` that populates the rest of the admin shell's CASL Ability object. There is no secondary permission matrix to maintain.

### 2.2 Native RBAC via M02 patterns

Three distinct permission tiers are needed for the jobs UI:

| Action | Required permission | Roles with this permission |
|---|---|---|
| View queue list + job list + job detail | `jobs:view` | admin, super_admin, supervisor |
| Retry a job / remove a job | `jobs:retry` | admin, super_admin |
| Pause queue / resume queue | `jobs:retry` | admin, super_admin |
| Drain queue / drain DLQ | `jobs:drain` | super_admin only |

Bull-Board collapses these to a single binary guard (pass/fail). Any user who can see the UI can click every button. That is unacceptable for a compliance-sensitive deployment where supervisors have read-only view into job state but must not be able to drain a DLQ.

### 2.3 Native audit via C03

C03's audit contract (to be established) requires every privileged data-mutation action to produce an `audit_log` row with: actor (user_id), action (string), target (resource + id), tenant_id, ip_address, created_at. Bull-Board mutates BullMQ state via internal API calls with no hook point for external audit writers.

The custom Fastify handlers call an `auditLog.write()` helper (same pattern as other admin routes) after each successful mutation. This satisfies the C03 inbound contract without any adapter shim.

### 2.4 Embedded in admin shell

The `(admin)/jobs/` pages import the same `PageHeader`, `DataTable`, `BulkActionBar`, and sonner-backed `toast()` primitives as every other admin section. Navigation breadcrumbs work. The keyboard-accessible `AdminSidebar` includes a Jobs entry. Accessibility audits (`@axe-core/playwright`) apply uniformly.

An iframe would require separate accessibility certification, separate dark-mode theming, and would break the browser's native scroll behavior on mobile (iframe scroll jank is a well-known iOS Safari regression).

### 2.5 DLQ stream awareness

W01 (§5) defines the DLQ as Valkey streams (`events:vici2.dlq.*`), not BullMQ failed sets. The DLQ stream entries contain richer context than BullMQ's native failed job data: `worker_id`, `source_id`, `attempt`, `ts` (millisecond-precision stream timestamp), plus the raw `payload` and `error_stack`. Bull-Board's "failed" tab reads from BullMQ's sorted set (`bull:queue:failed`); it has zero awareness of the Valkey stream DLQ. The custom `GET /api/admin/jobs/dlq/:queue` endpoint uses `XRANGE events:vici2.dlq.{queue} - + COUNT 100` to page through entries in stream order, exposing all DLQ metadata in a purpose-built table.

DLQ replay (`POST /api/admin/jobs/dlq/:queue/:entry-id/retry`) is equally stream-native: read the entry's `payload` field, `XADD` to the source queue (reconstituting the job), then `XACK` the DLQ entry. This two-step is atomic from the operator's perspective (retried or not), not from a Redis transaction perspective — the API documents this and the UI shows a "retry requested" confirmation.

---

## 3. Required Operations

### 3.1 Queue operations

| Operation | BullMQ API | Notes |
|---|---|---|
| List queue + state counts | `Queue.getJobCounts()` | Returns { waiting, active, completed, failed, delayed, paused } |
| Get is-paused | `Queue.isPaused()` | Boolean |
| Pause queue | `Queue.pause()` | Drains no jobs; new enqueues go to `paused` state |
| Resume queue | `Queue.resume()` | Re-enables dequeuing |
| Drain queue | `Queue.drain(delayed?)` | Removes waiting (and optionally delayed) jobs. DESTRUCTIVE. |
| Get queue metrics | `Queue.getMetrics('completed'|'failed', start?, end?)` | Rolling counters; distinct from gauge counts |

Stream-based queues (recording-log-writer, freeswitch-event-router) do not use BullMQ Queue API. Their "queue depth" is `XLEN events:vici2.{stream}`. Pause/resume is not semantically meaningful for XREADGROUP consumers — the UI shows depth + consumer group lag (XPENDING count) instead.

Callback tick queues (callback-fire/upcoming/stale) are setInterval + Valkey lock. Their "state" is: lock held (key exists) = tick is running; lock absent = idle. The UI shows lock holder hostname+pid (from the lock value) and the lock TTL (`TTL t:{tid}:cron:lock:callback_fire`). Pause = SET the lock with a "paused-by-admin" sentinel value and infinite TTL (until operator resumes). Resume = DEL the lock, allowing the setInterval to reacquire.

### 3.2 Job operations

| Operation | BullMQ API | Notes |
|---|---|---|
| List jobs by state | `Queue.getJobs(types, start, end, asc?)` | `types` = array of states; cursor via start/end (offset, not cursor) |
| Get single job | `Queue.getJob(jobId)` | Returns `Job \| undefined` |
| Retry a failed job | `job.retry('failed')` | Moves from failed set back to waiting |
| Remove a job | `job.remove()` | Removes from any state |
| Get job logs | `Queue.getJobLogs(jobId, start?, end?, asc?)` | Structured log lines appended via `job.log()` |

BullMQ paginates `getJobs()` by index offset (start/end) within each state's sorted set. This is not cursor-based — it is a Redis ZRANGE by rank. Page size recommendation: 20 jobs per page to avoid large Redis ZRANGE scans on the failed set (which can grow large).

### 3.3 DLQ operations

| Operation | Valkey command | Notes |
|---|---|---|
| List DLQ entries | `XRANGE stream - + COUNT n` | Forward pagination; next cursor = last entry-id |
| Count DLQ entries | `XLEN stream` | |
| Get single entry | `XRANGE stream id id` | Exact entry lookup |
| Retry DLQ entry | `XADD source-queue-or-stream * ...fields` + `XACK dlq-stream group entry-id` | Two-step; not transactional |
| Remove DLQ entry | `XDEL stream entry-id` | Permanent removal from stream |
| Drain DLQ (all) | `DEL stream` or `XTRIM stream MAXLEN 0` | DESTRUCTIVE; super_admin only |

Note: `XADD` to a BullMQ queue stream is not the correct way to re-enqueue a BullMQ job. BullMQ jobs must be re-enqueued via `Queue.add()` to get proper BullMQ metadata (jobId, timestamps, opts). The retry path must: (1) parse `payload` from DLQ entry, (2) call `Queue.add(worker, payload, opts)` to create a fresh BullMQ job, (3) `XACK` the DLQ entry. For stream-based workers (recording-log-writer), replay uses `XADD events:vici2.recording.stopped * ...fields` to re-insert the event into the source stream.

### 3.4 Cross-cutting requirements

**Pagination:** All list endpoints use cursor-style pagination based on BullMQ's index offsets (for jobs) and Redis Stream entry IDs (for DLQ). The UI shows a "load next page" button, not infinite scroll, because failed job sets can be very large and virtualizing them adds complexity without proportional user benefit.

**Polling fallback:** If the WebSocket connection drops, the queue index page falls back to polling `GET /api/admin/jobs/queues` every 5 seconds. Individual job detail pages poll every 10 seconds. The WS event (`events:vici2.bullmq.job.completed`, `events:vici2.bullmq.job.failed`, etc.) triggers an optimistic TanStack Query cache invalidation so the queue counts update without full refetch.

**Concurrency safety:** Multiple admin users can act on the same job simultaneously. BullMQ's `job.retry()` is idempotent (already-waiting jobs cannot be retried twice). `job.remove()` returns false if the job is already gone. The API handlers check return values and return 409 Conflict if the operation was already applied.

---

## 4. Open Questions

### 4.1 RESOLVED: Should Bull-Board be used for an initial prototype?

**Decision: No.** The audit and RBAC requirements are non-negotiable from day one of operator use. Shipping a prototype without them and retrofitting later would require two full UI rewrites (proto → Bull-Board with guard → custom). The custom implementation is 3-4 days of scoped work; the retrofit cost of a Bull-Board prototype is higher.

### 4.2 OPEN: Exact RBAC permission names

The permission identifiers `jobs:view`, `jobs:retry`, `jobs:drain` are proposed in this plan. They must be added to the static role→permission matrix in `shared/types/src/rbac.ts` by the F05 IMPLEMENT team before W02 IMPLEMENT begins. W02-PLAN proposes the names; F05 or M02 IMPLEMENT must register them. **Action: W02-PLAN to add a request to the F05/M02 amendment backlog.**

### 4.3 OPEN: Stream-queue UX for pause/resume

The W01 PLAN explicitly states that stream-based workers (recording-log-writer, freeswitch-event-router) cannot be paused via BullMQ API — they use XREADGROUP and have no pause mechanism. The proposed W02 UI shows these as "stream (unpaused)" with no pause button. Operators who need to stop a stream consumer must scale the worker to 0 replicas (out of scope for the admin UI). **Question for orchestrator:** Should W02 expose a "Drain consumer group pending" button that XACK-acks all pending entries (data loss risk) or is this too dangerous for the UI? **Proposed answer: No — too risky. Drain pending is CLI-only.**

### 4.4 OPEN: Sensitive-data masking scope

The mask-by-default approach (phone numbers, emails, SSNs in job.data) is proposed. The exact regex patterns and field-name allowlist must be defined. Proposed:
- Mask any string field value matching `/^[+]?1?\s*[-.]?\s*\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}$/` (NANP phone).
- Mask any string field value matching standard email regex.
- Mask any key named `ssn`, `social_security`, `dob`, `date_of_birth`, `pan`, `credit_card` regardless of value.
- Replace matched values with `***REDACTED***`.
- The opt-in unmask toggle requires `jobs:view` + `super_admin` role (separate from `jobs:drain`).
**Action: confirm masking scope with compliance team before W02 IMPLEMENT.**

### 4.5 OPEN: Callback tick queue admin (pause semantics)

Pausing a setInterval-based tick (callback-fire/upcoming/stale) by inserting a "paused-by-admin" sentinel lock is a novel pattern not covered by W01. It would require the tick workers to check for the sentinel before executing (adding a branch in callback-fire loop). **Question:** Is this pause semantics worth implementing in Phase 1? **Proposed answer: Defer. Phase 1 shows lock state (running/idle/TTL) as read-only; pause/resume of tick workers is out of W02 scope. Document as Phase 2.**

### 4.6 OPEN: WS event topics for BullMQ state changes

BullMQ does not natively publish job lifecycle events to Redis Streams. The W01 shared lib `metrics.ts` registers on BullMQ `completed`/`failed` events server-side. For W02 real-time updates, the worker process must additionally publish lightweight events to `events:vici2.bullmq.job.completed`, `events:vici2.bullmq.job.failed`, etc. (via `XADD` with MAXLEN ~ 1000 and very short TTL). **Action: W02-PLAN to request W01 IMPLEMENT to add these publish calls to the shared lib `setupWorkerMetrics()` function, or W02 IMPLEMENT does it as an amendment to workers/src/lib/metrics.ts.**

### 4.7 OPEN: DLQ drain confirmation UX

Draining an entire DLQ is irreversible data loss. The UI should require a typed confirmation (`type "drain lead-import dlq" to confirm`) similar to GitHub's repo-delete flow. **Decision: Yes, implement typed confirmation. Out of scope for initial API design; captured here for UI implementation.**

### 4.8 OPEN: Job data size limit

Some jobs (e.g., lead-import) may have `job.data` fields containing very large JSON payloads (pre-signed URLs, large metadata). The `GET /api/admin/jobs/queues/:queue/jobs/:id` endpoint should cap `data` and `returnvalue` fields at 64 KB each and return a `_truncated: true` flag if truncation occurs. **Decision: Yes, implement 64 KB cap in the API handler.**

---

*End of W02 RESEARCH*
