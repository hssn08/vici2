# W01 — Workers Infrastructure — PLAN

| Field | Value |
|---|---|
| Module | W01 (Workers Infrastructure, Phase 1) |
| Author | W01-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Status | PROPOSED — awaiting orchestrator/human review |
| Companion | [RESEARCH.md](./RESEARCH.md) |
| Depends on (FROZEN) | F04 (Valkey contract), F05 (JWT), O01 (Prometheus scrape), F02 (schema) |
| Blocks | D02-IMPLEMENT, D06-IMPLEMENT, R01-IMPLEMENT, R02-IMPLEMENT, C03-IMPLEMENT, D05-IMPLEMENT, T01-IMPLEMENT |

This plan is the binding contract for the vici2 workers infrastructure. W01 defines the BullMQ topology, queue configuration, DLQ pattern, observability hooks, deployment model, health endpoints, graceful shutdown, idempotency contract, cron schedule, rate limiting, trace propagation, and the `workers/` file structure refactor. Individual module plans (D02, D06, R01, R02, etc.) define _what_ their jobs do; W01 defines _how_ all jobs run.

Once approved, the following are **FROZEN**: queue names, DLQ stream names, per-queue `attempts`/`backoff`/`lockDuration`/`removeOnComplete`/`removeOnFail` defaults, shared lib module public APIs, `/health` and `/ready` response shapes, Prometheus metric names in `vici2_bullmq_*` family, W3C traceparent propagation contract, and the idempotency key convention. Internal implementation of shared lib modules may change without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **Two worker packages, two docker-compose services.** `@vici2/workers` (port 9103) handles lead-import, callback-fire, recording-log-writer, audit-attest, DNC sync, and freeswitch-event-router. `@vici2/recording-uploader` (port 9104) is a separate service with an NFS mount for R02. No consolidation — different resource profiles and mount requirements.

2. **BullMQ topology FROZEN: 11 named queues.** All BullMQ queue names follow the `vici2:queue:{worker}` convention (full name, no BullMQ `prefix` option). Callback-fire ticks use `setInterval` + Valkey advisory lock, not BullMQ repeat (sub-minute cadence). Recording-log-writer and freeswitch-event-router use Redis Streams XREADGROUP directly.

3. **DLQ = Valkey stream `events:vici2.dlq.{worker}`.** Terminal BullMQ failures XADD to the per-worker DLQ stream. Retention: `MAXLEN ~ 10000`, 30-day expiry policy enforced by DlqWriter. No BullMQ DLQ queues for new workers (recording-upload-dlq queue in R02 is grandfathered but not extended).

4. **Sandboxed processor for lead-import only.** The CSV hot loop runs in a child process (`processor.cjs`) to isolate OOM crashes. All other workers use in-thread async (I/O-bound; no sandboxing overhead needed). Recording-uploader's 10-concurrency model is safe in-thread.

5. **Shared `workers/src/lib/` with 6 modules.** `shutdown.ts`, `health-server.ts`, `dlq-writer.ts`, `metrics.ts`, `backoff.ts`, `tracing.ts`. These replace the ad-hoc patterns currently scattered across worker index files. Every worker MUST use these shared modules.

6. **Graceful shutdown: drain in-flight, then force.** `Worker.close()` with 50-second timeout; force after 60 seconds. Lead-import: 300-second drain. `/ready` returns 503 during shutdown. Docker `stop_grace_period: 60s` for standard workers; `300s` for lead-import.

7. **Idempotency is mandatory.** Every job that writes to DB or calls an external API MUST carry a ULID idempotency key AND implement one of: BullMQ jobId dedup, DB CAS (`WHERE x IS NULL` / `ON DUPLICATE KEY UPDATE`), or Valkey `SET NX`. The idempotency mechanism MUST be documented in the job source file header.

8. **W3C traceparent in `job.opts.tracecontext`.** API enqueue paths forward the HTTP `traceparent` header. Processors log `{ traceparent }` at INFO on job start and forward it on any API callback calls. Phase 2: OTel replaces this with proper span propagation.

9. **`/health` (liveness) + `/ready` (readiness) on every worker process.** `/health` → always 200 if process is alive. `/ready` → 200 when Valkey PING + DB connection are healthy; 503 otherwise and during shutdown. Results cached 5s.

10. **No MySQL additions from W01.** BullMQ uses Valkey exclusively. DLQ uses Valkey streams. Per-queue settings are code configuration only. Schema additions belong to individual module plans.

---

## 1. Goals and Non-Goals

### 1.1 Goals (W01 = infrastructure, not individual queues)

- Define and freeze the complete BullMQ queue topology across all modules.
- Establish per-queue configuration (concurrency, attempts, backoff, lockDuration, removeOnComplete, removeOnFail).
- Create shared `workers/src/lib/` infrastructure modules used by all workers.
- Define the DLQ pattern (Valkey stream, entry schema, retention, monitoring).
- Define graceful shutdown behavior and Docker/K8s configuration.
- Define `/health` and `/ready` endpoints with standard request/response shapes.
- Define Prometheus metrics for queue depth, job duration, attempt counts, and DLQ depth.
- Define W3C traceparent propagation contract for job-level tracing.
- Define ULID idempotency key convention.
- Define cron schedule for all repeatable jobs with O02 window awareness.
- Define rate limiting (per-queue global cap + per-tenant enqueue gate).
- Define worker pool sizing (concurrency × replica = total throughput).
- Fix the existing SIGTERM bug in `workers/src/index.ts` (no BullMQ drain).
- Refactor `workers/` file structure to accommodate all current and planned workers.

### 1.2 Non-Goals (explicitly out of W01 scope)

- What individual jobs do (D02 owns lead-import logic; D06 owns callback-fire logic; etc.).
- MySQL schema additions (owned by individual modules via F02 amendment batches).
- FreeSWITCH configuration (F03).
- API route RBAC for job enqueue endpoints (owned by each module).
- S3/storage backend selection for recording-uploader (owned by R02).
- DNC list download logic (owned by D05).
- Email delivery worker logic (owned by N01 Phase 4; W01 declares the queue slot).
- Kubernetes YAML manifests (owned by O04 Phase 4).
- BullMQ Flow Producer / parent-child job chains (Phase 2 for D02 shard splitting; W01 documents the seam).

---

## 2. BullMQ Topology FROZEN

The following 11 queues represent the complete set of BullMQ-managed + stream-managed queues across all vici2 modules. This list is authoritative. Adding a new queue requires an RFC against W01.

### 2.1 Queue inventory

| # | Queue name | Pattern | Owner module | Worker package |
|---|---|---|---|---|
| 1 | `vici2:queue:lead-import` | BullMQ Worker (sandboxed) | D02 | @vici2/workers |
| 2 | `vici2:queue:recording-upload` | BullMQ Worker | R02 | @vici2/recording-uploader |
| 3 | `vici2:queue:recording-delete-local` | BullMQ Worker | R02 | @vici2/recording-uploader |
| 4 | `vici2:queue:recording-log-writer` | Redis Streams XREADGROUP | R01 | @vici2/workers |
| 5 | `vici2:queue:callback-fire` | setInterval + Valkey lock | D06 | @vici2/workers |
| 6 | `vici2:queue:callback-upcoming` | setInterval + Valkey lock | D06 | @vici2/workers |
| 7 | `vici2:queue:callback-stale` | setInterval + Valkey lock | D06 | @vici2/workers |
| 8 | `vici2:queue:audit-attest` | BullMQ repeatable (nightly) | C03 | @vici2/workers |
| 9 | `vici2:queue:federal-dnc-sync` | BullMQ repeatable (weekly) | D05 | @vici2/workers |
| 10 | `vici2:queue:state-dnc-sync` | BullMQ repeatable (monthly) | D05 | @vici2/workers |
| 11 | `vici2:queue:freeswitch-event-router` | Redis Streams XREADGROUP | T01 | @vici2/workers |

**Design notes:**
- Queues 4, 11 (stream-based): not BullMQ queues in the traditional sense; they use Redis Streams XREADGROUP. They appear in this table because W01 governs their stream names, consumer group names, and DLQ handling.
- Queues 5, 6, 7 (setInterval-based): use Valkey advisory locks per tenant, not BullMQ queues. They appear here because W01 governs their lock key naming and tick cadence.
- Recording-upload-dlq (`recording-upload-dlq`) is a grandfathered BullMQ queue from R02's existing implementation. W01 does not adopt this as a pattern for new workers; new workers use Valkey stream DLQ.

### 2.2 Redis Streams consumer group names (FROZEN)

| Stream | Consumer group | Consumer name pattern |
|---|---|---|
| `events:vici2.recording.stopped` | `recording-log-writer` | `recording-log-writer-{hostname}-{pid}` |
| `events:vici2.recording.stopped` | `r02-uploader` | `r02-uploader-{hostname}-{pid}` |
| `events:vici2.call.*` (multiple) | `freeswitch-event-router` | `freeswitch-event-router-{hostname}-{pid}` |

XAUTOCLAIM idle time: 60,000 ms for all consumers (matches existing recording-log-writer pattern).

### 2.3 Valkey advisory lock keys (FROZEN)

| Worker | Key | EX (TTL) |
|---|---|---|
| callback-fire | `t:{tid}:cron:lock:callback_fire` | 60s |
| callback-upcoming | `t:{tid}:cron:lock:callback_upcoming` | 90s |
| callback-stale | `t:{tid}:cron:lock:callback_stale` | 300s |

---

## 3. Per-Queue Configuration

### 3.1 Lead import (`vici2:queue:lead-import`)

```typescript
const LEAD_IMPORT_JOB_OPTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },  // 5s, 10s, 20s
  removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 1_000 },
};

new Worker('vici2:queue:lead-import', processorPath, {
  connection: valkeyConn,
  concurrency: 2,
  lockDuration: 60_000,     // ms; renewed every 30s by BullMQ
  stalledInterval: 30_000,  // ms; check for stalled jobs every 30s
});
```

- **concurrency: 2** — saturates a 4-vCPU box with the sandboxed processor (each subprocess uses ~1.5 vCPU during CSV parsing). Two workers = 3 vCPU used, leaving 1 for Node event loop.
- **lockDuration: 60_000** — 1 M-row import runs for ~17 min; the lock is renewed every 30s so expiry doesn't apply.
- **attempts: 3** — transient DB errors on bulk insert. Resume from `imports.row_count_processed` checkpoint on retry.
- **Processor**: sandboxed (`processor.cjs`). Compiled from `workers/src/jobs/lead-import/processor.ts`.

### 3.2 Recording upload (`vici2:queue:recording-upload`)

```typescript
const RECORDING_UPLOAD_JOB_OPTS: DefaultJobOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },  // 30s base; ±25% jitter in processor
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1_000 },
};

new Worker('recording-upload', processor, {  // Note: R02 uses bare name (grandfathered)
  connection: valkeyConn,
  concurrency: 10,
  lockDuration: 120_000,   // 2 min; large file multipart uploads can take 90s
  stalledInterval: 60_000,
});
```

- **concurrency: 10** — parallel S3 PutObject calls; bounded by 4 × 16 MB part buffer = 640 MB peak.
- **attempts: 8** — S3 transient errors are slow to resolve; 8 attempts + 3 delayed-retry tiers = ~30 hr total.
- **lockDuration: 120_000** — accounts for multipart upload of large files (460 MB at ~10 MB/s = 46s).

### 3.3 Recording delete-local (`vici2:queue:recording-delete-local`)

```typescript
const RECORDING_DELETE_JOB_OPTS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

new Worker('recording-delete-local', processor, {
  connection: valkeyConn,
  concurrency: 5,
  lockDuration: 30_000,
  stalledInterval: 15_000,
});
```

- **concurrency: 5** — `fs.unlink` is very fast; 5 concurrent is safe.
- **attempts: 5** — ENOENT on unlink is treated as success (idempotent); other errors retry.

### 3.4 Audit attest (`vici2:queue:audit-attest`)

```typescript
const AUDIT_ATTEST_JOB_OPTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },  // 60s, 120s, 240s
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 90 * 24 * 3600, count: 100 },
};

new Worker('vici2:queue:audit-attest', processor, {
  connection: valkeyConn,
  concurrency: 1,
  lockDuration: 300_000,   // 5 min; full attestation for all tables can take ~3 min
  stalledInterval: 60_000,
});
```

- **concurrency: 1** — nightly job; only one instance should run at a time.
- **lockDuration: 300_000** — 5 tables × all rows for yesterday → Merkle + sign + S3 PUT can take 3+ min on large tenants.

### 3.5 Federal DNC sync (`vici2:queue:federal-dnc-sync`)

```typescript
const FEDERAL_DNC_SYNC_JOB_OPTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 300_000 },  // 5 min base; FTP download is slow
  removeOnComplete: { age: 30 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600, count: 100 },
};

new Worker('vici2:queue:federal-dnc-sync', processor, {
  connection: valkeyConn,
  concurrency: 1,
  lockDuration: 1_800_000,  // 30 min; FTC file download + Bloom load can take 20 min
  stalledInterval: 300_000,
});
```

### 3.6 State DNC sync (`vici2:queue:state-dnc-sync`)

```typescript
const STATE_DNC_SYNC_JOB_OPTS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 120_000 },  // 2 min base
  removeOnComplete: { age: 30 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600, count: 100 },
};

new Worker('vici2:queue:state-dnc-sync', processor, {
  connection: valkeyConn,
  concurrency: 3,   // up to 3 state syncs in parallel (different states)
  lockDuration: 900_000,   // 15 min per state file
  stalledInterval: 120_000,
});
```

### 3.7 Per-queue configuration table (summary)

| Queue | concurrency | attempts | backoff base | lockDuration | removeOnComplete | removeOnFail |
|---|---|---|---|---|---|---|
| `lead-import` | 2 | 3 | 5s exp | 60s | 7d age, 10k count | 30d age, 1k count |
| `recording-upload` | 10 | 8 | 30s exp+jitter | 120s | 100 count | 1k count |
| `recording-delete-local` | 5 | 5 | 5s exp | 30s | 100 count | 500 count |
| `audit-attest` | 1 | 3 | 60s exp | 300s | 7d age | 90d age, 100 count |
| `federal-dnc-sync` | 1 | 3 | 300s exp | 1800s | 30d age | 30d age, 100 count |
| `state-dnc-sync` | 3 | 5 | 120s exp | 900s | 30d age | 30d age, 100 count |
| `callback-*` ticks | N/A (setInterval) | N/A | N/A | N/A (Valkey lock) | N/A | N/A |
| `recording-log-writer` | N/A (stream) | 5 (internal retry) | 500ms linear | N/A | N/A | DLQ stream after 5 |
| `freeswitch-event-router` | N/A (stream) | 3 (internal retry) | 1s linear | N/A | N/A | DLQ stream after 3 |

---

## 4. Sandboxed Processor Pattern

### 4.1 When to use sandboxed processors

**Use sandboxed processor** (child process) when:
- Job handler is CPU-bound (CSV parsing, image processing, cryptographic operations).
- A crash/OOM in the handler would kill the parent worker process and drop other in-flight jobs.
- The job's hot loop benefits from V8 isolation (fresh heap per subprocess).

**Use in-thread async** when:
- Job handler is I/O-bound (S3 upload, DB writes, Redis ops, HTTP calls).
- The job is short-lived (< 10 seconds typical).
- IPC serialization cost would dominate job work.

| Queue | Pattern | Reason |
|---|---|---|
| `lead-import` | **Sandboxed** | CSV hot loop is CPU-bound; OOM in csv-parse kills child, not parent |
| `recording-upload` | In-thread | S3 upload is I/O-bound; SHA-256 streaming is Node-native fast |
| `recording-delete-local` | In-thread | `fs.unlink` is I/O-bound |
| `audit-attest` | In-thread | Merkle + Ed25519 is fast (< 1s for typical day's rows) |
| `federal-dnc-sync` | In-thread | FTP download + Bloom load is I/O-bound |
| `state-dnc-sync` | In-thread | Same as federal |

### 4.2 Sandboxed processor implementation

```typescript
// workers/src/jobs/lead-import/worker.ts
new Worker('vici2:queue:lead-import',
  path.resolve(__dirname, 'processor.cjs'),  // child process path (compiled)
  {
    connection: valkeyConn,
    concurrency: 2,
    lockDuration: 60_000,
    stalledInterval: 30_000,
    useWorkerThreads: false,  // subprocess, not worker_threads
  }
);
```

```typescript
// workers/src/jobs/lead-import/processor.ts (compiled to processor.cjs)
// Must call: const { Worker } = require('bullmq'); module.exports = async (job) => { ... }
import { Job } from 'bullmq';

// processorPath MUST be a CommonJS file (BullMQ subprocess requirement):
// The TypeScript source is compiled with: tsc --module commonjs --outFile processor.cjs
```

**Build requirement**: The processor must be compiled to CJS (not ESM) because BullMQ spawns it via `child_process.fork` which doesn't support `--input-type=module`. Add a separate `tsconfig.processor.json` with `"module": "commonjs"`.

### 4.3 Process pool behavior

BullMQ reuses child processes across jobs (process pool, not one-process-per-job). Pool size = `concurrency` (2 for lead-import). Each child process handles one job at a time. If a child crashes, BullMQ marks the job as failed and respawns a fresh child.

The crashed job is retried (up to `attempts: 3`) with the exponential backoff. The parent worker process continues handling other queues/jobs unaffected.

---

## 5. DLQ Pattern

### 5.1 Dead-letter queue: Valkey stream per worker

Every BullMQ worker and stream consumer that exhausts its retry budget MUST write a dead-letter entry to the per-worker DLQ stream before acknowledging/removing the job. The DLQ is not consumed automatically — it requires operator intervention or a future DLQ replay worker.

**DLQ stream names (FROZEN):**

| Worker | DLQ stream |
|---|---|
| lead-import | `events:vici2.dlq.lead-import` |
| recording-log-writer | `events:vici2.dlq.recording-log-writer` |
| recording-upload | `events:vici2.dlq.recording-upload` |
| recording-delete-local | `events:vici2.dlq.recording-delete-local` |
| audit-attest | `events:vici2.dlq.audit-attest` |
| federal-dnc-sync | `events:vici2.dlq.federal-dnc-sync` |
| state-dnc-sync | `events:vici2.dlq.state-dnc-sync` |
| freeswitch-event-router | `events:vici2.dlq.freeswitch-event-router` |
| callback-fire | `events:vici2.dlq.callback-fire` |

### 5.2 DLQ entry schema (FROZEN)

```
XADD events:vici2.dlq.{worker} MAXLEN ~ 10000 *
  worker        "{worker-name}"
  source_queue  "vici2:queue:{worker}" | "events:vici2.recording.stopped"
  source_id     "{bullmq_job_id}" | "{redis_stream_entry_id}"
  payload       "{JSON.stringify(job.data)}"
  error         "{error.message.slice(0, 512)}"
  error_stack   "{error.stack?.slice(0, 1024) ?? ''}"
  attempt       "{job.attemptsMade}"
  worker_id     "{hostname}-{pid}"
  tenant_id     "{tenantId}"
  ts            "{Date.now()}"
```

`MAXLEN ~ 10000` keeps each DLQ stream bounded at approximately 10,000 entries. Approximate trimming (the `~` operator) avoids locking the stream on every XADD.

### 5.3 DlqWriter shared module

```typescript
// workers/src/lib/dlq-writer.ts

export interface DlqEntry {
  worker: string;
  sourceQueue: string;
  sourceId: string;
  payload: unknown;
  error: Error;
  attempt: number;
  workerId: string;
  tenantId: string | number | bigint;
}

export class DlqWriter {
  constructor(
    private readonly redis: Redis,
    private readonly maxLen: number = 10_000,
  ) {}

  async write(stream: string, entry: DlqEntry): Promise<string | null> {
    return this.redis.xadd(
      stream,
      'MAXLEN', '~', this.maxLen.toString(),
      '*',
      'worker',       entry.worker,
      'source_queue', entry.sourceQueue,
      'source_id',    entry.sourceId,
      'payload',      JSON.stringify(entry.payload),
      'error',        entry.error.message.slice(0, 512),
      'error_stack',  entry.error.stack?.slice(0, 1024) ?? '',
      'attempt',      String(entry.attempt),
      'worker_id',    entry.workerId,
      'tenant_id',    String(entry.tenantId),
      'ts',           String(Date.now()),
    );
  }
}
```

Usage in BullMQ worker `failed` event:
```typescript
worker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
    await dlqWriter.write(`events:vici2.dlq.${workerName}`, {
      worker: workerName,
      sourceQueue: queueName,
      sourceId: job.id ?? 'unknown',
      payload: job.data,
      error: err,
      attempt: job.attemptsMade,
      workerId: `${hostname()}-${process.pid}`,
      tenantId: job.data.tenantId ?? '0',
    });
  }
});
```

### 5.4 DLQ retention

30-day retention is enforced via Valkey stream MAXLEN (count-based) + a nightly O02-adjacent cleanup. The MAXLEN ~ 10000 acts as a circuit breaker; if a worker is producing > 10,000 DLQ entries the oldest are evicted automatically. For audit purposes, the DLQ entry count is also emitted as a Prometheus gauge (see §9).

### 5.5 DLQ replay (Phase 2)

A future `workers/src/jobs/dlq-replay/` job can be added without RFC, as it is additive. The replay job:
1. `XREADGROUP` from the DLQ stream.
2. Deserializes `payload` from the entry.
3. Re-enqueues to the source queue.
4. Writes an audit event (`worker.dlq.replayed`).
5. `XACK` the DLQ stream entry.

---

## 6. Worker Pool Sizing

### 6.1 Per-container concurrency × replica = total concurrency

Phase 1 deploys 1 replica per worker process. The total concurrency is thus equal to the per-container concurrency.

| Worker process | Concurrency/container | Phase 1 Replicas | Total concurrency | Notes |
|---|---|---|---|---|
| `@vici2/workers` (lead-import) | 2 | 1 | 2 | CPU-bound (sandboxed) |
| `@vici2/workers` (callback-fire tick) | 1 per tenant | 1 | 1 | setInterval + Valkey lock |
| `@vici2/workers` (callback-upcoming tick) | 1 per tenant | 1 | 1 | setInterval + Valkey lock |
| `@vici2/workers` (callback-stale tick) | 1 per tenant | 1 | 1 | setInterval + Valkey lock |
| `@vici2/workers` (recording-log-writer) | 1 (XREADGROUP) | 1 | 1 | XAUTOCLAIM handles crashes |
| `@vici2/workers` (audit-attest) | 1 | 1 | 1 | Nightly cron |
| `@vici2/workers` (federal-dnc-sync) | 1 | 1 | 1 | Weekly cron |
| `@vici2/workers` (state-dnc-sync) | 3 | 1 | 3 | Parallel state downloads |
| `@vici2/workers` (freeswitch-event-router) | 1 (XREADGROUP) | 1 | 1 | XAUTOCLAIM handles crashes |
| `@vici2/recording-uploader` (upload) | 10 | 1 | 10 | I/O-bound (S3) |
| `@vici2/recording-uploader` (delete-local) | 5 | 1 | 5 | I/O-bound (fs.unlink) |

### 6.2 Phase 4 K8s horizontal scaling

When deployed to K8s (Phase 4), the recording-uploader is the primary candidate for HPA:
```yaml
# HorizontalPodAutoscaler example
scaleTargetRef: recording-uploader
metrics:
  - type: External
    external:
      metric:
        name: vici2_bullmq_jobs_waiting
        selector:
          matchLabels:
            queue: recording-upload
      target:
        type: Value
        value: "50"  # scale up when 50+ jobs waiting
minReplicas: 1
maxReplicas: 5
```

Lead-import is **not** a HPA candidate (concurrency is limited by CPU, not waiting jobs). State-dnc-sync may scale to `concurrency: 5` in Phase 4 for faster national coverage.

### 6.3 Valkey connection budget

Each BullMQ Worker requires 2 ioredis connections internally. Stream consumers require 1. Total Valkey connections:
- `@vici2/workers`: 1 lead-import × 2 + 5 other workers × 2 + 2 stream consumers × 1 = 16 connections.
- `@vici2/recording-uploader`: 2 workers × 2 + 1 stream consumer × 1 + 3 queues (for depth gauge) = 8 connections.
- Total: ~24 connections. Trivial for Valkey (10,000 max).

### 6.4 MySQL connection budget

Prisma connection pools:
- `@vici2/workers`: `?connection_limit=15` → concurrency_sum(2+1+1+3) = 7 active DB connections at peak + headroom = 15 is safe.
- `@vici2/recording-uploader`: `?connection_limit=20` → concurrency_sum(10+5) = 15 active DB connections at peak.
- Total workers DB: ~35 connections. Plus api(20) + dialer(25) = 80 total. Well within `max_connections=500`.

---

## 7. Deployment

### 7.1 Phase 1: docker-compose services

Add the following to `docker-compose.dev.yml`:

```yaml
services:
  workers:
    build:
      context: workers
      dockerfile: Dockerfile
    env_file: .env
    environment:
      - VALKEY_URL=redis://valkey:6379/0
      - REDIS_URL=redis://valkey:6379/0
      - DATABASE_URL=${DATABASE_URL}?connection_limit=15
      - METRICS_PORT=9103
      - LOG_LEVEL=info
    depends_on:
      valkey: { condition: service_healthy }
      mysql: { condition: service_healthy }
    ports:
      - "9103:9103"
    stop_grace_period: 60s
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9103/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  recording-uploader:
    build:
      context: workers/recording-uploader
      dockerfile: Dockerfile
    env_file: .env
    environment:
      - VALKEY_URL=redis://valkey:6379/0
      - REDIS_URL=redis://valkey:6379/0
      - DATABASE_URL=${DATABASE_URL}?connection_limit=20
      - R02_METRICS_PORT=9104
      - R02_CONCURRENCY=10
      - R02_SWEEPER_INTERVAL_SEC=300
      - LOG_LEVEL=info
    volumes:
      - recordings:/recordings    # NFS mount in production; local volume in dev
    depends_on:
      valkey: { condition: service_healthy }
      mysql: { condition: service_healthy }
    ports:
      - "9104:9104"
    stop_grace_period: 60s
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9104/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

**Prometheus scrape targets** to add to `infra/observability/prometheus/prometheus.yml`:
```yaml
- job_name: 'vici2-workers'
  static_configs:
    - targets: ['workers:9103']
  metrics_path: /metrics
  scrape_interval: 15s

- job_name: 'vici2-recording-uploader'
  static_configs:
    - targets: ['recording-uploader:9104']
  metrics_path: /metrics
  scrape_interval: 15s
```

### 7.2 Phase 4: Kubernetes

Per-module K8s Deployments (not defined in W01 PLAN; owned by O04 Phase 4):
```
infra/k8s/workers-lead-import.yaml
infra/k8s/workers-callback-fire.yaml
infra/k8s/workers-recording-log-writer.yaml
infra/k8s/workers-recording-uploader.yaml
infra/k8s/workers-audit-attest.yaml
infra/k8s/workers-dnc-sync.yaml
```

Key K8s settings (documented here as guidance for O04):
- `terminationGracePeriodSeconds: 60` for all workers except lead-import.
- `terminationGracePeriodSeconds: 300` for `workers-lead-import` (long CSV jobs).
- `livenessProbe`: `GET /health`, initial delay 15s, period 30s, failure threshold 3.
- `readinessProbe`: `GET /ready`, initial delay 5s, period 10s, failure threshold 2.

### 7.3 Dockerfiles

`workers/Dockerfile` (to be updated by W01 IMPLEMENT):
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# Copy shared workspace dependencies first (pnpm workspace)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/ ./shared/
COPY workers/package.json ./workers/
RUN corepack enable && pnpm install --frozen-lockfile --filter @vici2/workers

COPY workers/src ./workers/src
COPY workers/tsconfig.json ./workers/
RUN cd workers && pnpm exec tsc -p tsconfig.json
# Compile sandboxed processor to CJS
RUN cd workers && pnpm exec tsc -p tsconfig.processor.json

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/workers/dist ./dist
COPY --from=base /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

`workers/recording-uploader/Dockerfile` (already exists; verify):
```dockerfile
FROM node:20-alpine
WORKDIR /app
# ... existing content
```

---

## 8. Health Check and Readiness Endpoints

### 8.1 WorkerHttpServer shared module

```typescript
// workers/src/lib/health-server.ts

export interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
  timeoutMs?: number;
}

export interface WorkerHttpServerOpts {
  port: number;
  metricsRegistry: Registry;
  service: string;
  readinessChecks: HealthCheck[];
}

export class WorkerHttpServer {
  private server: http.Server;
  private ready = true;
  private cachedReadiness: { ok: boolean; checks: Record<string, string> } | null = null;
  private cacheExpiry = 0;

  constructor(private readonly opts: WorkerHttpServerOpts) {
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  /** Call during shutdown to start returning 503 /ready */
  setNotReady(): void { this.ready = false; this.cachedReadiness = null; }

  listen(): void { this.server.listen(this.opts.port); }
  close(): void { this.server.close(); }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/metrics') {
      res.setHeader('content-type', this.opts.metricsRegistry.contentType);
      res.end(await this.opts.metricsRegistry.metrics());
    } else if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: this.opts.service }));
    } else if (req.url === '/ready') {
      const { ok, checks } = await this.getReadiness();
      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ready: ok, service: this.opts.service, checks }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  }

  private async getReadiness(): Promise<{ ok: boolean; checks: Record<string, string> }> {
    if (!this.ready) return { ok: false, checks: { shutdown: 'in-progress' } };
    const now = Date.now();
    if (this.cachedReadiness && now < this.cacheExpiry) return this.cachedReadiness;

    const checks: Record<string, string> = {};
    let allOk = true;
    for (const { name, check, timeoutMs = 2000 } of this.opts.readinessChecks) {
      try {
        const result = await Promise.race([
          check(),
          new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
        ]);
        checks[name] = result ? 'ok' : 'error';
        if (!result) allOk = false;
      } catch {
        checks[name] = 'error';
        allOk = false;
      }
    }

    this.cachedReadiness = { ok: allOk, checks };
    this.cacheExpiry = now + 5_000;
    return this.cachedReadiness;
  }
}
```

### 8.2 Standard readiness checks

Every worker MUST include:

```typescript
const healthServer = new WorkerHttpServer({
  port: Number(process.env.METRICS_PORT ?? 9103),
  metricsRegistry: registry,
  service: 'workers',
  readinessChecks: [
    {
      name: 'valkey',
      check: async () => { await redis.ping(); return true; },
    },
    {
      name: 'db',
      check: async () => { await prisma.$queryRaw`SELECT 1`; return true; },
    },
  ],
});
```

`@vici2/recording-uploader` adds:
```typescript
{
  name: 's3',
  check: async () => { await backend.ping(); return true; },
},
```

### 8.3 Response shapes (FROZEN)

```json
// GET /health — always 200 if process alive
{ "status": "ok", "service": "workers" }

// GET /ready — 200 when all checks pass
{ "ready": true, "service": "workers", "checks": { "valkey": "ok", "db": "ok" } }

// GET /ready — 503 during shutdown or check failure
{ "ready": false, "service": "workers", "checks": { "valkey": "ok", "db": "error" } }

// GET /metrics — Prometheus text format
```

---

## 9. Prometheus Metrics

### 9.1 BullMQ queue metrics (shared, polled every 30s)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `vici2_bullmq_jobs_active` | Gauge | `queue` | `Queue.getActiveCount()` |
| `vici2_bullmq_jobs_waiting` | Gauge | `queue` | `Queue.getWaitingCount()` |
| `vici2_bullmq_jobs_delayed` | Gauge | `queue` | `Queue.getDelayedCount()` |
| `vici2_bullmq_jobs_failed` | Gauge | `queue` | `Queue.getFailedCount()` |
| `vici2_bullmq_jobs_completed` | Gauge | `queue` | `Queue.getCompletedCount()` |
| `vici2_bullmq_job_duration_seconds` | Histogram | `queue`, `status` | `job.finishedOn - job.processedOn` (ms → s) |
| `vici2_bullmq_job_wait_seconds` | Histogram | `queue` | `job.processedOn - job.timestamp` |
| `vici2_bullmq_job_attempts_total` | Counter | `queue`, `outcome` (`completed`\|`failed`\|`dlq`) | Worker events |
| `vici2_worker_dlq_depth` | Gauge | `worker` | `XLEN events:vici2.dlq.*` (polled 60s) |

Histograms buckets for `job_duration_seconds`: `0.1, 0.5, 1, 5, 15, 30, 60, 300, 600, 1800`.
Histograms buckets for `job_wait_seconds`: `0.05, 0.1, 0.5, 1, 5, 30, 120`.

### 9.2 Shared metrics module

```typescript
// workers/src/lib/metrics.ts

import client from 'prom-client';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'vici2_node_' });

export const bullmqJobsActive = new client.Gauge({
  name: 'vici2_bullmq_jobs_active',
  help: 'Number of currently active BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsWaiting = new client.Gauge({
  name: 'vici2_bullmq_jobs_waiting',
  help: 'Number of waiting BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsDelayed = new client.Gauge({
  name: 'vici2_bullmq_jobs_delayed',
  help: 'Number of delayed BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsFailed = new client.Gauge({
  name: 'vici2_bullmq_jobs_failed',
  help: 'Number of failed BullMQ jobs (in failed set)',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobDuration = new client.Histogram({
  name: 'vici2_bullmq_job_duration_seconds',
  help: 'BullMQ job execution duration in seconds',
  labelNames: ['queue', 'status'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 600, 1800],
  registers: [registry],
});

export const bullmqJobWait = new client.Histogram({
  name: 'vici2_bullmq_job_wait_seconds',
  help: 'Time a BullMQ job spent waiting in queue before processing',
  labelNames: ['queue'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 30, 120],
  registers: [registry],
});

export const bullmqJobAttempts = new client.Counter({
  name: 'vici2_bullmq_job_attempts_total',
  help: 'Total BullMQ job attempt outcomes',
  labelNames: ['queue', 'outcome'] as const,
  registers: [registry],
});

export const workerDlqDepth = new client.Gauge({
  name: 'vici2_worker_dlq_depth',
  help: 'Number of entries in the per-worker DLQ stream',
  labelNames: ['worker'] as const,
  registers: [registry],
});

/** Poll queue depths and DLQ depths every pollIntervalMs (default 30s). */
export function startMetricsPoller(
  queues: Map<string, Queue>,
  dlqStreams: Map<string, string>,  // worker → stream name
  redis: Redis,
  pollIntervalMs = 30_000,
): () => void {
  const interval = setInterval(async () => {
    for (const [name, queue] of queues) {
      try {
        const [active, waiting, delayed, failed] = await Promise.all([
          queue.getActiveCount(),
          queue.getWaitingCount(),
          queue.getDelayedCount(),
          queue.getFailedCount(),
        ]);
        bullmqJobsActive.set({ queue: name }, active);
        bullmqJobsWaiting.set({ queue: name }, waiting);
        bullmqJobsDelayed.set({ queue: name }, delayed);
        bullmqJobsFailed.set({ queue: name }, failed);
      } catch { /* non-fatal; log at debug */ }
    }
    for (const [worker, stream] of dlqStreams) {
      try {
        const len = await redis.xlen(stream);
        workerDlqDepth.set({ worker }, len);
      } catch { /* non-fatal */ }
    }
  }, pollIntervalMs);
  return () => clearInterval(interval);
}
```

### 9.3 Per-job timing instrumentation

Every Worker's `completed` and `failed` event handlers MUST record timing:

```typescript
// In setupWorkerMetrics(worker, queueName, registry):
worker.on('completed', (job) => {
  if (!job.processedOn || !job.finishedOn || !job.timestamp) return;
  bullmqJobDuration.observe({ queue: queueName, status: 'completed' },
    (job.finishedOn - job.processedOn) / 1000);
  bullmqJobWait.observe({ queue: queueName },
    (job.processedOn - job.timestamp) / 1000);
  bullmqJobAttempts.inc({ queue: queueName, outcome: 'completed' });
});

worker.on('failed', (job, err) => {
  if (!job) return;
  bullmqJobAttempts.inc({ queue: queueName, outcome: 'failed' });
  if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
    bullmqJobAttempts.inc({ queue: queueName, outcome: 'dlq' });
  }
});
```

### 9.4 Alert rules (to add to O01)

```yaml
# infra/observability/prometheus/rules/workers.yml
groups:
  - name: workers
    rules:
      - alert: WorkerDlqGrowing
        expr: vici2_worker_dlq_depth > 0
        for: 5m
        labels: { severity: warn }
        annotations:
          summary: "Worker DLQ has entries: {{ $labels.worker }}"

      - alert: WorkerDlqCritical
        expr: vici2_worker_dlq_depth > 10
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "Worker DLQ > 10 entries: {{ $labels.worker }}"

      - alert: BullMQQueueBacklog
        expr: vici2_bullmq_jobs_waiting{queue=~"vici2:queue:.*"} > 500
        for: 10m
        labels: { severity: warn }
        annotations:
          summary: "BullMQ queue backlog: {{ $labels.queue }}"

      - alert: WorkerJobDurationHigh
        expr: histogram_quantile(0.95, rate(vici2_bullmq_job_duration_seconds_bucket[5m])) > 300
        for: 5m
        labels: { severity: warn }
        annotations:
          summary: "P95 job duration > 5 min: {{ $labels.queue }}"
```

---

## 10. Trace Propagation

### 10.1 W3C traceparent via job.opts.tracecontext (FROZEN)

All enqueue calls from the API layer MUST forward the HTTP `traceparent` header:

```typescript
// api/src/routes/*/handlers/*.ts — at enqueue time
await queue.add('import', jobData, {
  ...defaultJobOpts,
  tracecontext: {
    traceparent: req.headers['traceparent'] as string | undefined,
    tracestate:  req.headers['tracestate'] as string | undefined,
  },
  jobId: idempotencyKey,
});
```

All processors MUST read and log the traceparent at job start:

```typescript
// workers/src/lib/tracing.ts
export function extractTraceparent(job: Job): string | undefined {
  return (job.opts as any)?.tracecontext?.traceparent;
}

export function logJobStart(logger: Logger, job: Job, queueName: string): void {
  logger.info({
    jobId: job.id,
    queue: queueName,
    attempt: job.attemptsMade,
    traceparent: extractTraceparent(job),
    tenantId: (job.data as any)?.tenantId,
  }, `${queueName}: job started`);
}
```

### 10.2 Traceparent forwarding on API callbacks

When a worker calls back to the API (e.g., recording-log-writer updating `recording_log` via API rather than direct DB), it MUST include the traceparent as an HTTP header:

```typescript
const response = await fetch('http://api:3000/internal/recordings/...', {
  headers: {
    'Authorization': `Bearer ${serviceJwt}`,
    'traceparent': job.opts.tracecontext?.traceparent ?? '',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});
```

Phase 2: replace this with OTel span propagation via `@opentelemetry/sdk-node`.

### 10.3 Tracing in structured logs

Every log line emitted during job execution MUST include `{ traceparent, jobId, queue }` as base fields via pino `child` logger:

```typescript
const jobLogger = logger.child({
  jobId: job.id,
  queue: queueName,
  traceparent: extractTraceparent(job),
});
```

---

## 11. Graceful Shutdown

### 11.1 ShutdownManager shared module

```typescript
// workers/src/lib/shutdown.ts

export interface Closeable {
  name: string;
  close: () => Promise<void>;
  timeoutMs?: number;
}

export class ShutdownManager {
  private shuttingDown = false;
  private readonly closeables: Closeable[] = [];

  register(closeable: Closeable): void {
    this.closeables.push(closeable);
  }

  async shutdown(signal: string, logger: Logger): Promise<never> {
    if (this.shuttingDown) return process.exit(0);
    this.shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown initiated');

    for (const closeable of [...this.closeables].reverse()) {
      const timeout = closeable.timeoutMs ?? 50_000;
      try {
        await Promise.race([
          closeable.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout closing ${closeable.name}`)), timeout)
          ),
        ]);
        logger.info({ name: closeable.name }, 'closed successfully');
      } catch (err) {
        logger.warn({ name: closeable.name, err }, 'force-closed after timeout');
      }
    }

    logger.info('shutdown complete');
    process.exit(0);
  }

  register(signal: string, logger: Logger): void {
    const handler = () => void this.shutdown(signal, logger);
    process.on(signal, handler);
  }
}
```

### 11.2 Standard shutdown sequence

Every worker process MUST follow this shutdown sequence (in order):

1. **Set not-ready** (`healthServer.setNotReady()`) — /ready returns 503 immediately.
2. **Stop accepting new jobs** — `Worker.pause()` (BullMQ) or stop the setInterval (tick workers).
3. **Drain in-flight jobs** — `Worker.close(false)` with timeout.
4. **Close stream consumers** — call `consumer.stop()` and wait for the XREADGROUP loop to exit.
5. **Close DB connection pool** — `prisma.$disconnect()`.
6. **Close Valkey connections** — `redis.disconnect()`.
7. **Close HTTP server** — `healthServer.close()`.
8. **Exit** — `process.exit(0)`.

```typescript
// Example: workers/src/index.ts (refactored)
const shutdown = new ShutdownManager();
shutdown.register('SIGTERM', logger);
shutdown.register('SIGINT', logger);

// Registration order matters — shutdown reverses it
shutdown.register({ name: 'lead-import-worker',
  close: async () => { await leadImportWorker.close(false); },
  timeoutMs: 300_000  // lead-import: 5 min drain
});
shutdown.register({ name: 'callback-fire',
  close: async () => { callbackFireIntervals.forEach(clearInterval); }
});
shutdown.register({ name: 'recording-log-writer',
  close: async () => { recordingLogWriter.stop(); }
});
shutdown.register({ name: 'audit-attest-worker',
  close: async () => { await auditAttestWorker.close(false); },
  timeoutMs: 50_000
});
shutdown.register({ name: 'prisma',
  close: async () => { await prisma.$disconnect(); }
});
shutdown.register({ name: 'redis',
  close: async () => { redis.disconnect(); }
});
shutdown.register({ name: 'http-server',
  close: async () => { healthServer.close(); }
});
```

### 11.3 Lead-import special case

The lead-import worker uses a sandboxed processor. When `Worker.close()` is called, BullMQ waits for the in-flight job to finish. If the timeout (300s) expires, BullMQ calls the child process with `SIGKILL`. The job's `row_count_processed` checkpoint (updated every 500 rows) means the next retry picks up where it left off without data loss.

Operators who need immediate shutdown can send `SIGKILL` directly; the job will be requeued on next worker startup (BullMQ stalled job detection, interval = 30s).

### 11.4 No-new-jobs during shutdown

BullMQ `Worker.pause()` prevents the worker from picking up new jobs while allowing in-flight jobs to complete. This is distinct from `Worker.close()` which starts the full shutdown. The correct sequence:

```typescript
// On SIGTERM received:
await worker.pause(true);       // stop picking up new jobs (true = wait for current to yield)
healthServer.setNotReady();     // signal readiness probe failure
await worker.close(false);      // drain in-flight with timeout
```

---

## 12. Job Idempotency Contract

### 12.1 Idempotency is mandatory

Every job that performs a DB write, external API call, or file system operation MUST be idempotent. The at-least-once BullMQ delivery model (stalled job re-queuing, SIGTERM on active job) makes this non-negotiable.

### 12.2 ULID idempotency keys

Every user-triggered job MUST include a ULID idempotency key in `job.data`. System-triggered jobs (cron) MUST derive a deterministic key from the job's execution window.

```typescript
// User-triggered (enqueue at API)
const idempotencyKey = ulid();  // from 'ulidx' package
await queue.add('import', {
  importId,
  tenantId,
  idempotencyKey,           // included in job.data
}, {
  jobId: importId,          // BullMQ-level dedup by jobId
});

// Cron job (deterministic key from window)
const windowKey = `audit-attest:${windowDate}:${tenantId}`;
await queue.add('attest', {
  windowDate,
  tenantId,
  idempotencyKey: ulidFromSeed(windowKey),  // deterministic ULID from seed
}, {
  repeat: { pattern: '30 3 * * *' },
  jobId: windowKey,
});
```

### 12.3 Idempotency mechanisms by job type

| Job | BullMQ jobId | DB CAS | Valkey NX | Notes |
|---|---|---|---|---|
| lead-import | `importId` | `WHERE storage_url IS NULL` | — | D01 batch key also deduplicates |
| recording-upload | `recordingLogId.toString()` | `WHERE storage_url IS NULL` | — | HEAD check on retry skips re-upload |
| recording-delete-local | — | `deletion_pending=FALSE` update | — | ENOENT treated as success |
| audit-attest | `windowKey` | `INSERT IGNORE` (UNIQUE KEY) | — | Unique constraint is the primary guard |
| federal-dnc-sync | `"federal-dnc-sync:YYYY-WW"` | `dnc_sync_log` upsert | — | Weekly window key prevents double-run |
| state-dnc-sync | `"state-dnc-sync:{state}:YYYY-MM"` | `dnc_sync_log` upsert | — | Per-state monthly window key |
| recording-log-writer | N/A | `ON DUPLICATE KEY UPDATE updated_at = updated_at` | — | Unique key on `(uuid, start_time)` |

### 12.4 Source file documentation requirement

Every processor file MUST include a header comment documenting its idempotency mechanism:
```typescript
/**
 * @idempotency BullMQ jobId = importId (dedup in active set);
 *              DB CAS: `UPDATE imports SET status='running' WHERE status='queued'`;
 *              Resume from `row_count_processed` checkpoint on retry.
 */
```

---

## 13. Cron Jobs

### 13.1 All repeatable jobs and their schedules

| Job | Queue | Schedule (UTC) | BullMQ jobId | Notes |
|---|---|---|---|---|
| Audit attestation | `vici2:queue:audit-attest` | `30 3 * * *` (03:30 daily) | `audit-attest:{YYYY-MM-DD}` | Avoids 02:00–02:30 backup window (O02) |
| Federal DNC sync | `vici2:queue:federal-dnc-sync` | `0 4 * * 0` (04:00 Sunday) | `federal-dnc-sync:{YYYY-WW}` | Avoids Sunday backup window; FTC releases weekly |
| State DNC sync | `vici2:queue:state-dnc-sync` | `30 4 1 * *` (04:30 1st of month) | `state-dnc-sync:{state}:{YYYY-MM}` | C04 partition at 03:30; 04:30 is clear |
| Callback-fire tick | N/A (setInterval) | Every 30s | N/A | D06 PLAN §6.2; Valkey lock per tenant |
| Callback-upcoming tick | N/A (setInterval) | Every 60s | N/A | D06 PLAN §6.4; Valkey lock per tenant |
| Callback-stale tick | N/A (setInterval) | Every 5 min | N/A | D06 PLAN §8.2; Valkey lock per tenant |
| Recording sweeper | N/A (setInterval) | Every 5 min | N/A | R02; sweeper in recording-uploader process |

### 13.2 BullMQ repeat initialization

Repeatable jobs MUST be initialized at worker startup via `Queue.add` with repeat options. This is idempotent — BullMQ deduplicates by repeat key:

```typescript
// workers/src/index.ts — at startup
await auditAttestQueue.add('attest', {}, {
  repeat: { pattern: '30 3 * * *', tz: 'UTC' },
  jobId: 'audit-attest-cron-v1',
});

await federalDncSyncQueue.add('sync', {}, {
  repeat: { pattern: '0 4 * * 0', tz: 'UTC' },
  jobId: 'federal-dnc-sync-cron-v1',
});

await stateDncSyncQueue.add('sync', {}, {
  repeat: { pattern: '30 4 1 * *', tz: 'UTC' },
  jobId: 'state-dnc-sync-cron-v1',
});
```

### 13.3 O02 backup window avoidance (FROZEN)

The following time ranges are RESERVED and no heavy cron jobs (DB-intensive, DDL) may run in these windows:
- **02:00–02:30 UTC daily**: MySQL nightly backup (`mysqldump --single-transaction`).
- **02:30–03:00 UTC daily**: Valkey BGSAVE + S3 copy.
- **03:00–03:30 UTC 1st of month**: C04 partition rotation.

Current cron schedule is clear of all windows. Any new cron jobs added in future modules MUST avoid these windows.

---

## 14. Rate Limiting

### 14.1 Per-queue global rate limit (BullMQ limiter)

Heavy processing queues get a global throughput cap to protect downstream services:

```typescript
// lead-import: limit to 5 active jobs globally (MySQL connection protection)
new Worker('vici2:queue:lead-import', processorPath, {
  connection: valkeyConn,
  concurrency: 2,
  limiter: { max: 5, duration: 60_000 },  // max 5 starts per minute globally
});

// recording-upload: limit to 50 uploads per minute (S3 rate protection)
new Worker('recording-upload', processor, {
  connection: valkeyConn,
  concurrency: 10,
  limiter: { max: 50, duration: 60_000 },
});
```

BullMQ's `limiter` applies per Worker instance. For multi-replica deployments (Phase 4), use BullMQ's group-rate-limiter feature (BullMQ Pro) or a Valkey-side counter.

### 14.2 Per-tenant enqueue gate (API layer)

Each module's HTTP API enforces per-tenant rate limits at enqueue time via F04 Valkey rate limiter:

| Queue | Per-tenant limit | Enforcement point |
|---|---|---|
| `lead-import` | 5 imports/minute per tenant | `POST /api/admin/lists/:id/imports` |
| `recording-upload` | Auto-generated (1 per call) | Not user-triggered |
| `state-dnc-sync` | Admin-only; 1 active sync per state | Worker enforces via Valkey lock |
| `federal-dnc-sync` | System-triggered | BullMQ jobId dedup |

Rate limit enforcement uses F04's `VALKEY_URL` and a Valkey key:
```
t:{tid}:ratelimit:enqueue:{worker}
```
Incremented on each enqueue; TTL = window duration. Exceeds limit → 429 Too Many Requests.

### 14.3 Per-tenant concurrency limit

Some jobs should not run more than N instances per tenant simultaneously. This is enforced via a Valkey counter:

```typescript
// Before enqueue (in API handler):
const activeCnt = await redis.incr(`t:${tenantId}:workers:active:lead-import`);
await redis.expire(`t:${tenantId}:workers:active:lead-import`, 3600);
if (activeCnt > 2) {
  await redis.decr(`t:${tenantId}:workers:active:lead-import`);
  throw new TooManyRequestsError('Maximum 2 concurrent lead imports per tenant');
}

// On job completion (in worker):
await redis.decr(`t:${tenantId}:workers:active:lead-import`);
```

---

## 15. Schema Additions

### 15.1 No MySQL additions from W01

BullMQ stores all job state in Valkey. DLQ entries are stored in Valkey streams. W01 introduces zero MySQL tables, columns, or indexes.

### 15.2 Valkey keyspace additions from W01 (FROZEN)

| Key pattern | Type | Purpose | TTL |
|---|---|---|---|
| `events:vici2.dlq.*` | Stream | Per-worker dead-letter queues | MAXLEN ~ 10000 |
| `vici2:worker:ready:{worker}` | STRING | Cached readiness result (`1`\|`0`) | 5s |
| `t:{tid}:workers:active:{worker}` | STRING (counter) | Per-tenant active job count | 3600s |
| `t:{tid}:ratelimit:enqueue:{worker}` | STRING (counter) | Per-tenant enqueue rate limit | window-length |

BullMQ's own keyspace (under `bull:*`) is managed by BullMQ internally.

---

## 16. Files to Create

### 16.1 Shared library (`workers/src/lib/`)

```
workers/src/lib/
├── shutdown.ts            # ShutdownManager: register closeables, drain on SIGTERM
├── health-server.ts       # WorkerHttpServer: /health, /ready, /metrics
├── dlq-writer.ts          # DlqWriter: XADD to events:vici2.dlq.* with standard schema
├── metrics.ts             # Shared prom-client registry + BullMQ metric setup
├── backoff.ts             # jitter(delay, fraction) utility (±25% uniform jitter)
├── tracing.ts             # extractTraceparent(), logJobStart(), propagateTraceparent()
└── __tests__/
    ├── shutdown.test.ts   # ShutdownManager unit tests
    ├── backoff.test.ts    # jitter range assertions
    └── tracing.test.ts   # traceparent extraction + propagation
```

### 16.2 Workers entry point refactor

```
workers/src/
├── index.ts               # REFACTORED: uses ShutdownManager, WorkerHttpServer, metrics
│                          # Registers all workers: lead-import, callback-fire,
│                          #   recording-log-writer, audit-attest, dnc-sync,
│                          #   freeswitch-event-router
└── jobs/
    ├── lead-import/
    │   ├── worker.ts      # UPDATED: uses shared lib; adds Worker.pause() on shutdown
    │   ├── processor.ts   # UPDATED: calls logJobStart(); adds @idempotency header comment
    │   └── tsconfig.processor.json  # NEW: { "module": "commonjs" } for CJS output
    ├── callback-fire/
    │   └── index.ts       # UPDATED: uses ShutdownManager.register() instead of raw process.on
    ├── recording-log-writer/
    │   └── index.ts       # UPDATED: uses DlqWriter; logs traceparent
    ├── audit-attest/
    │   └── index.ts       # UPDATED: uses shared lib; BullMQ Worker instead of direct function
    ├── federal-dnc-sync/  # NEW (D05): BullMQ repeatable worker
    │   ├── worker.ts
    │   └── processor.ts
    ├── state-dnc-sync/    # NEW (D05): BullMQ repeatable worker
    │   ├── worker.ts
    │   └── processor.ts
    └── freeswitch-event-router/  # NEW (T01): Redis Streams consumer
        └── index.ts
```

### 16.3 Recording uploader updates

```
workers/recording-uploader/src/
├── index.ts       # UPDATED: uses WorkerHttpServer; adds /ready endpoint
└── ...            # existing files unchanged
```

### 16.4 Docker and compose

```
workers/
├── Dockerfile                   # UPDATED: two-stage build; compile processor.cjs separately
└── recording-uploader/
    └── Dockerfile               # VERIFY: exists and correct

docker-compose.dev.yml           # UPDATED: add recording-uploader service; update workers service

infra/observability/prometheus/
└── prometheus.yml               # UPDATED: add vici2-workers and vici2-recording-uploader scrape targets

infra/observability/prometheus/rules/
└── workers.yml                  # NEW: DLQ depth, queue backlog, job duration alerts
```

### 16.5 CI additions

```
scripts/ci/
└── check-worker-dlq-streams.sh  # NEW: verify DLQ streams have MAXLEN set
                                 # runs against Valkey in CI after integration tests
```

### 16.6 Environment variable additions (`.env.example`)

```bash
# Workers shared
METRICS_PORT=9103
WORKER_SHUTDOWN_TIMEOUT_MS=50000

# Recording uploader (R02) — additions
R02_METRICS_PORT=9104
R02_CONCURRENCY=10
R02_SWEEPER_INTERVAL_SEC=300

# DLQ configuration
WORKER_DLQ_MAXLEN=10000
```

---

## 17. Test Plan

### 17.1 Unit tests (`workers/src/lib/__tests__/`)

| Test file | Coverage goal | Key cases |
|---|---|---|
| `shutdown.test.ts` | 100% | Registered closeables called in reverse order; timeout triggers force-close; double-shutdown is idempotent |
| `backoff.test.ts` | 100% | `jitter(1000, 0.25)` always within [750, 1250]; deterministic seed produces values in range over 1000 samples |
| `tracing.test.ts` | 100% | `extractTraceparent` returns undefined for missing; returns value when present; `propagateTraceparent` sets header |
| `dlq-writer.test.ts` | 100% | `DlqWriter.write` calls XADD with correct fields; entry count increments; MAXLEN is applied |
| `health-server.test.ts` | 90% | `/health` always 200; `/ready` 200 when all checks pass; 503 when any check fails; 503 after `setNotReady()` |
| `metrics.test.ts` | 80% | Metrics are registered exactly once; `startMetricsPoller` polls queues and DLQ streams |

### 17.2 Integration tests (`workers/test/`)

| Test | Dependencies | Assertions |
|---|---|---|
| `lead-import-worker.test.ts` | Real Valkey + MySQL | Job enqueue → worker picks up → processes 100-row CSV → `imports.status='done'`; SIGTERM during processing → job requeued; next run resumes from checkpoint |
| `callback-fire.test.ts` | Real Valkey + MySQL | Existing D06 tick tests; extend: SIGTERM during tick → intervals cleared; no double-fire across instances (Valkey lock) |
| `audit-attest-worker.test.ts` | Real Valkey + MySQL | BullMQ repeat initialization idempotent (add twice → 1 job); job runs; `audit_attestation` row inserted |
| `dlq-writer.test.ts` | Real Valkey | After max retries, DLQ stream has 1 entry; XLEN returns 1; entry has correct `worker` and `error` fields |
| `health-server.test.ts` | Valkey + MySQL containers | `/ready` 200 when connected; 503 when Valkey disconnected; 503 during shutdown |
| `shutdown.test.ts` | Valkey + MySQL containers | SIGTERM → in-flight job completes → process exits 0; SIGTERM during long job → drains up to timeout → force exits |
| `graceful-shutdown-lead-import.test.ts` | Valkey + MySQL | Enqueue 1 M-row import; SIGTERM after 1000 rows; `row_count_processed = 1000`; restart → resumes from batch 2 |

### 17.3 Docker-compose smoke tests

```bash
# Verify services start and are healthy
make dev
curl -sf http://localhost:9103/health    # → {"status":"ok","service":"workers"}
curl -sf http://localhost:9103/ready     # → {"ready":true,...}
curl -sf http://localhost:9104/health    # → {"status":"ok","service":"recording-uploader"}
curl -sf http://localhost:9104/ready     # → {"ready":true,...}
curl -sf http://localhost:9103/metrics | grep vici2_bullmq_jobs_waiting  # → has data
```

### 17.4 Coverage targets

| Package | Target |
|---|---|
| `workers/src/lib/` | ≥ 90% line coverage |
| `workers/src/index.ts` (refactored) | ≥ 70% |
| `workers/src/jobs/*/worker.ts` | ≥ 70% |
| `workers/src/jobs/*/processor.ts` | Per-module plan (D02: 80%, C03: 70%) |

---

## 18. Acceptance Criteria

- [ ] `workers/src/lib/` contains all 6 shared modules (`shutdown.ts`, `health-server.ts`, `dlq-writer.ts`, `metrics.ts`, `backoff.ts`, `tracing.ts`) with unit tests passing.
- [ ] `workers/src/index.ts` uses `ShutdownManager` and `WorkerHttpServer`; `Worker.close()` is called on SIGTERM with timeout.
- [ ] All 11 queues from §2 are defined in code with the configurations from §3.
- [ ] `/health` returns 200 on both worker services when healthy; `/ready` returns 503 after SIGTERM is received.
- [ ] `GET /metrics` on both services includes all `vici2_bullmq_*` metrics with correct label values.
- [ ] DLQ streams (`events:vici2.dlq.*`) receive entries when a job exhausts retries; XLEN is emitted as `vici2_worker_dlq_depth`.
- [ ] Lead-import sandboxed processor (`processor.cjs`) is compiled and loadable; a CSV job processed by the sandboxed subprocess completes correctly.
- [ ] SIGTERM during an active lead-import job: job drains within 300s; `row_count_processed` is set correctly; restarted worker resumes without duplicate inserts.
- [ ] BullMQ repeatable jobs (audit-attest, federal-dnc-sync, state-dnc-sync) are initialized at startup; re-running `index.ts` does not create duplicate repeat entries.
- [ ] W3C traceparent from the HTTP request appears in worker log lines at INFO level for every enqueued job.
- [ ] `docker compose up workers recording-uploader` starts cleanly; both `/health` endpoints return 200 within 30s; Prometheus scrapes both targets (verify in Prometheus target list at `http://localhost:9090/targets`).
- [ ] O01 alert rule `WorkerDlqCritical` fires in a test scenario where 11 DLQ entries are written.
- [ ] Worker shutdown time (SIGTERM → process exit) is ≤ 60s for standard workers and ≤ 300s for lead-import. Verified by Docker stop timing test.
- [ ] `make test-workers` runs all unit + integration tests and passes with real MySQL 8 + Valkey containers.
- [ ] `scripts/ci/check-worker-dlq-streams.sh` verifies all DLQ streams have MAXLEN configured; passes in CI.

---

## 19. Dependencies and Risks

### 19.1 Hard dependencies (must be in place before W01 IMPLEMENT)

| Dependency | Why needed | Status |
|---|---|---|
| F04 (Valkey) | BullMQ connection; DLQ streams; advisory locks | HANDOFF (done) |
| F05 (JWT) | Service JWT for worker→API callbacks | HANDOFF (done) |
| O01 (Prometheus) | Scrape targets; alert rules in `workers.yml` | HANDOFF (done) |
| F02 (MySQL) | `prisma.$disconnect()` at shutdown; per-job DB access | HANDOFF (done) |

### 19.2 Soft dependencies (W01 provides; others consume)

| Downstream module | What they get from W01 |
|---|---|
| D02 IMPLEMENT | Sandboxed processor pattern; `vici2:queue:lead-import` frozen config |
| D06 IMPLEMENT | Shared shutdown module for tick workers; `vici2:queue:callback-*` frozen |
| R01 IMPLEMENT | DlqWriter for recording-log-writer; stream DLQ |
| R02 IMPLEMENT | WorkerHttpServer (for /ready endpoint); metrics module |
| C03 IMPLEMENT | `vici2:queue:audit-attest` BullMQ worker pattern |
| D05 IMPLEMENT | `vici2:queue:federal-dnc-sync`, `vici2:queue:state-dnc-sync` frozen config |
| T01 IMPLEMENT | `vici2:queue:freeswitch-event-router` stream consumer slot |
| O04 IMPLEMENT | K8s YAML guidance (§7.2); alert rules (§9.4) |

### 19.3 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `workers/src/index.ts` SIGTERM bug (no BullMQ drain) is a current production defect | High (confirmed by code) | Medium (jobs lost on restart) | Fixed in W01 IMPLEMENT (first PR) |
| Sandboxed processor compilation to CJS fails in monorepo setup | Medium | High (D02 blocked) | Add `tsconfig.processor.json`; CI gate compiles and tests it |
| BullMQ `lockDuration` too short for large lead-import files | Low | Medium | 60s lockDuration renewed every 30s; no realistic 1M-row job takes > 30s per batch |
| DLQ stream grows faster than MAXLEN trims (burst DLQ writes) | Low | Low | MAXLEN ~ is approximate; burst of 11k entries still trims to ~10k over next write |
| Multi-tenant support (single `VICI2_TENANT_ID`) blocks Phase 4 | High (by design) | Low (Phase 4 only) | Phase 4 RFC adds tenant iteration in all workers |
| `@vici2/auth/rbac` import in `wrapJob.ts` is unresolved | High (build error) | Medium (wrapJob unusable) | W01 IMPLEMENT either wires the rbac package or removes the import until F05 wires it in |
| NFS mount in `recording-uploader` service fails to mount on CI | Medium | Medium (R02 CI blocked) | CI uses local volume; NFS only for staging/prod |
| Recording-uploader's `recording-upload-dlq` BullMQ queue not converted to stream | Low | Low | Grandfathered; document in W01 HANDOFF as "not the pattern for new workers" |
| O01 scrape targets not added to `prometheus.yml` | Medium | Low (metrics invisible) | W01 IMPLEMENT includes prometheus.yml update as part of the PR |

### 19.4 Phase 4 deferred items

| Item | Phase | Notes |
|---|---|---|
| K8s Deployment YAML manifests | 4 | Owned by O04; W01 provides guidance in §7.2 |
| HorizontalPodAutoscaler for recording-uploader | 4 | Based on `vici2_bullmq_jobs_waiting{queue="recording-upload"}` |
| Multi-tenant worker iteration (all tenants, not just `VICI2_TENANT_ID=1`) | 4 | All tick workers iterate `SELECT id FROM tenants WHERE active=1` |
| BullMQ Flow Producer for D02 shard splitting | 2 | Seam documented in D02 PLAN §12.2 |
| OTel span propagation (replacing W3C traceparent manual propagation) | 2 | After `trigger: ≥ 3 incidents` per O01 HANDOFF §4 |
| DLQ replay worker | 2 | Manual operator action in Phase 1; automated in Phase 2 |
| Email delivery worker (password reset, notifications) | 4 | Queue slot: `vici2:queue:email-delivery`; reserved but not defined |
| BullMQ Pro group rate limiter for multi-tenant per-tenant throughput caps | 4 | Phase 1 uses per-tenant Valkey counter at enqueue (API layer) |

---

*End of W01 PLAN.md*
