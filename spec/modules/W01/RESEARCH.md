# W01 — Workers Infrastructure — RESEARCH

| Field | Value |
|---|---|
| Module | W01 (Workers Infrastructure, Phase 1) |
| Author | W01-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Status | RESEARCH — informs PLAN.md |
| Scope | BullMQ topology, retries, DLQ, observability, deployment, scaling for all vici2 background workers |

This document captures research findings, design options, and tradeoff analysis that underpin the W01 PLAN. All citation-equivalent references are to the actual spec files read during research rather than external papers.

---

## 1. Current State of Workers (as-shipped)

### 1.1 Existing packages

Two Node packages currently exist in `workers/`:

**Package 1: `@vici2/workers`** (`workers/`)
- Entry point: `workers/src/index.ts` — a stub that registers Prometheus metrics and serves `/metrics` on port 9103 and `/health`.
- Jobs registered so far: `lead-import` (D02), `callback-fire` (D06), `recording-log-writer` (R01), `audit-attest` (C03).
- Uses BullMQ `^5.76.8` + ioredis `^5.4.2`.
- Graceful shutdown: SIGTERM/SIGINT → `server.close() → process.exit(0)`. Does NOT drain in-flight BullMQ workers.

**Package 2: `@vici2/recording-uploader`** (`workers/recording-uploader/`)
- Full implementation of R02: Redis Streams consumer + BullMQ upload/delete workers + sweeper.
- Has its own `/metrics` and `/health` endpoints.
- Graceful shutdown: `consumer.stop() + uploadWorker.close() + deleteLocalWorker.close() + prisma.$disconnect()`.

### 1.2 Observed patterns in existing code

**wrapJob.ts** (`workers/src/wrapJob.ts`): A RBAC enforcement wrapper that applies `Can()` at dequeue time in addition to enqueue time. Supports `buildAuth`, `extractScope`, `auditWriter`. Currently only stubbed — no imported concrete implementation of `@vici2/auth/rbac` exists in the workers package yet.

**lead-import/worker.ts** (D02): Uses `concurrency: 2`, `lockDuration: 60_000`, `stalledInterval: 30_000`. The processor is loaded from `processImport` synchronously (not sandboxed subprocess in current code — the D02 PLAN calls for a sandboxed `processor.cjs`, not yet implemented). Lifecycle hooks (onActive, onCompleted, onFailed) update the `imports` table directly via `prisma.$executeRawUnsafe`.

**callback-fire/index.ts** (D06): Does NOT use BullMQ for the tick — uses `setInterval(30_000)` directly. Has Valkey `SET NX EX 60` advisory locks per tenant. Has proper SIGTERM/SIGINT handling that clears intervals, disconnects Prisma, and disconnects Redis before `process.exit(0)`. Phase 1: single-tenant via env var `VICI2_TENANT_ID`.

**recording-log-writer/index.ts** (R01): Uses Redis Streams directly (not BullMQ) — XREADGROUP + XACK with XADD to DLQ on failure. 5 retries before dead-letter. Cleanup of Valkey HASH (`t:{tid}:recording:{uuid}`) on success.

**audit-attest/index.ts** (C03): Not a BullMQ Worker — invoked by external cron scheduler. Contains the Merkle attestation + Ed25519 sign + S3 PUT + DB INSERT logic.

**recording-uploader/index.ts** (R02): Most mature pattern. Uses BullMQ Workers with concurrency, event handlers (failed → DLQ after attempts), Redis Streams consumer, sweeper on setInterval, proper graceful shutdown.

### 1.3 Queue name conventions observed

- `workers/recording-uploader/`: queue names are bare (`recording-upload`, `recording-delete-local`, `recording-upload-dlq`).
- D02 PLAN §6.1: queue name `vici2:queue:lead-import` (prefixed).
- The R02 package predated the `vici2:queue:` prefix convention or chose not to use it. W01 PLAN must decide: freeze the prefix convention going forward (prefixed is better for Redis key inspection).

---

## 2. BullMQ Architecture Review

### 2.1 BullMQ 5.x key facts

BullMQ 5.x (currently at `^5.76.8` in the project) stores jobs as Redis hashes under `bull:{queueName}:` prefix by default. Key structures:
- `bull:{q}:id` — job id counter
- `bull:{q}:{id}` — HASH with job data + state
- `bull:{q}:wait` — LIST of waiting jobs
- `bull:{q}:active` — SORTED SET of active jobs (score = lock expiry)
- `bull:{q}:completed` — SORTED SET (trimmed by removeOnComplete)
- `bull:{q}:failed` — SORTED SET (trimmed by removeOnFail)
- `bull:{q}:delayed` — SORTED SET (score = execution timestamp)
- `bull:{q}:paused` — LIST

With `prefix` option (e.g. `prefix: 'vici2'`), becomes `vici2:{queueName}:`. This matches the established `t:{tid}:` key namespace pattern from F04. However, F04 HANDOFF §5 shows `VALKEY_URL` is used for BullMQ too, and D02 PLAN §6.1 uses `vici2:queue:lead-import` as the full queue name (not as prefix+name). Two approaches:
- **Option A** (D02 pattern): Full queue name = `vici2:queue:{worker}`. BullMQ key = `bull:vici2:queue:{worker}:wait`.
- **Option B** (BullMQ prefix): `prefix: 'vici2'`, queue name = `queue:{worker}`. BullMQ key = `vici2:queue:{worker}:wait`.

Option A is simpler (no BullMQ `prefix` option needed) and is already established. W01 freezes Option A.

### 2.2 Worker concurrency model

BullMQ Worker concurrency is per-process. A Worker with `concurrency: N` processes up to N jobs simultaneously within a single Node.js event loop (non-blocking I/O). For CPU-bound work, BullMQ supports sandboxed processors (spawns a child process per job, with a process pool reused across calls). For I/O-bound work, in-thread async is correct.

**Sandboxed processor pattern** (D02 PLAN §6.1, bullet 4): Pass a filesystem path to the Worker constructor instead of a function. BullMQ spawns `child_process.fork(processorPath)` and uses the process pool. This isolates heap OOM and crashes in the CSV hot loop from the parent worker. The cost is IPC serialization of job data (typically <1 KB; acceptable for CSV imports).

For the remaining workers (callback-fire, recording-log-writer, audit-attest, DNC sync): these are I/O-bound (DB reads/writes, Redis ops, S3 uploads). In-thread async is appropriate; no sandboxed processor needed.

### 2.3 Job lockDuration and stalled jobs

`lockDuration` (default 30 s in BullMQ 5.x): the time a job's lock is valid before the "stalled job check" marks it as failed and returns it to the queue. The worker extends the lock via `extendLock` every `lockDuration / 2` milliseconds automatically in BullMQ 5.x.

For long-running I/O jobs (CSV import, large S3 upload): `lockDuration: 60_000` (60 s) is appropriate — the lock is renewed every 30 s, which is well under any processing timeout.

For short-running jobs (callback fire tick, recording-log-writer): `lockDuration: 30_000` (30 s default) is fine.

`stalledInterval` (how often BullMQ checks for stalled jobs): should be ≤ lockDuration / 2. D02 uses `stalledInterval: 30_000` with `lockDuration: 60_000` — correct.

### 2.4 Retry and backoff strategies

BullMQ supports:
1. `exponential` backoff: `delay × 2^(attempt-1)`
2. `fixed` backoff: constant delay
3. Custom function (BullMQ 5 adds `jitter` parameter alongside `delay` for exponential)

The project currently has two backoff patterns:
- D02: `{ type: 'exponential', delay: 5000 }` — 5s, 10s, 20s for 3 attempts. Good for fast transient DB errors.
- R02: `{ type: 'exponential', delay: 30_000 }` — 30s, 60s, ... for 8 attempts. Plus additional delayed-retry tiers. Good for slow external API (S3) timeouts.

**Jitter rationale**: Without jitter, all failed jobs from a thundering-herd event (e.g. S3 regional incident) retry at the same moments, recreating the herd. BullMQ does not add jitter natively in `^5.76.8`. R02 implements ±25% uniform jitter in the processor code itself (`delay * (0.75 + Math.random() * 0.5)`). W01 should standardize this as a shared utility.

### 2.5 removeOnComplete / removeOnFail

- `removeOnComplete: { age: N, count: M }` — removes completed jobs older than N seconds or when count exceeds M.
- `removeOnFail: { age: N, count: M }` — same for failed jobs.

Leaving these at defaults causes unbounded Redis memory growth. D02 uses `{ age: 7 * 24 * 3600, count: 10_000 }` for completed and `{ age: 30 * 24 * 3600 }` for failed. This is a good baseline. The DLQ captures terminal failures for longer-term analysis; the main queue's failed set can be more aggressively pruned.

### 2.6 Repeatable jobs (cron)

BullMQ supports repeatable jobs via `Queue.add(name, data, { repeat: { pattern: '30 3 * * *' } })`. These are stored in `bull:{q}:repeat` SORTED SET. The repeat scheduler fires jobs on schedule without external cron. BullMQ's repeat uses UTC times by default.

Current state: audit-attest is NOT using BullMQ repeat — it is described as "called by external cron scheduler." D06 uses `setInterval` not BullMQ repeat. DNC sync (D05) uses BullMQ repeat (implied by D06 PLAN §11 dependency on `federal-dnc-sync` and `state-dnc-sync`).

W01 should standardize: cron jobs that are I/O-bound and retry-safe SHOULD use BullMQ repeat. The `setInterval` pattern (D06 callback-fire) is appropriate ONLY for sub-minute ticks that need the Valkey advisory lock pattern.

### 2.7 Rate limiting

BullMQ 5.x supports per-queue rate limiting via `Worker` options:
```typescript
new Worker(queueName, processor, {
  limiter: { max: 10, duration: 1000 }  // max 10 jobs per 1000 ms
});
```
This is a per-worker-instance limit. For tenant-aware rate limiting (e.g. max 2 concurrent lead-import per tenant), the application must implement a tenant-scoped counter (Valkey `INCR` + TTL) before accepting a job into the queue.

Per-tenant rate limiting at enqueue time (API layer) is already done for D02 (5 rpm per tenant). Per-queue BullMQ rate limiting is for global throughput caps to protect downstream services (MySQL connection pool, S3 PutObject rate).

### 2.8 Flow producers (job chaining)

BullMQ Flow Producers allow a parent job to spawn child jobs and wait for all to complete. Used in D02 PLAN §12.2 bullet 3 as a Phase 2 feature (parallel shard splitting). Not needed in Phase 1; W01 documents the seam.

---

## 3. Dead Letter Queue (DLQ) Strategy

### 3.1 Existing DLQ patterns

Two DLQ patterns exist in the codebase:

**R02 pattern** (recording-uploader/index.ts): After all BullMQ attempts exhausted, the `failed` event handler adds the job data to a separate BullMQ queue (`recording-upload-dlq`). This is a BullMQ-to-BullMQ DLQ — easy to inspect, replay, and alert on via BullMQ Board.

**R01 pattern** (recording-log-writer/index.ts): After 5 retries, writes a message to a Redis Stream (`events:vici2.dlq.recording`). This is a Streams-to-Streams DLQ — consistent with the `events:vici2.*` namespace and visible alongside live events.

### 3.2 Design decision: unified DLQ namespace

W01 should freeze one DLQ pattern for BullMQ workers. Options:

**Option A** — BullMQ DLQ queue per source queue: `vici2:queue:{worker}-dlq`. Stored in Redis hashes like any BullMQ queue. Easy to inspect via BullMQ tooling.

**Option B** — Valkey Stream DLQ per worker: `events:vici2.dlq.{worker}`. Consistent with the `events:vici2.*` Streams namespace. Retention via MAXLEN (XADD MAXLEN ~). Multi-consumer can process DLQ entries.

**Decision**: W01 uses **Option B** (Valkey Stream DLQ) for BullMQ workers, mirroring the recording-log-writer pattern. Rationale: (a) the `events:vici2.*` namespace is the established event bus; (b) DLQ entries can be replayed by the same stream consumer pipeline; (c) O01 can scrape DLQ stream XLEN as a gauge for alerting without BullMQ-specific exporters; (d) R02's BullMQ DLQ queue pattern is tolerated as an existing implementation but not extended to new workers.

Retention: 30 days (2,592,000 seconds). Each DLQ stream capped via `MAXLEN ~ 10000` (approximate trimming to avoid head-of-list stalls). MAXLEN ~ is the BullMQ-idiomatic approach for streams without exact precision requirements.

DLQ stream names (per-worker):
- `events:vici2.dlq.lead-import`
- `events:vici2.dlq.recording-log-writer`
- `events:vici2.dlq.recording-upload`
- `events:vici2.dlq.recording-delete-local`
- `events:vici2.dlq.callback-fire` (for tick errors)
- `events:vici2.dlq.audit-attest`
- `events:vici2.dlq.federal-dnc-sync`
- `events:vici2.dlq.state-dnc-sync`
- `events:vici2.dlq.freeswitch-event-router`

### 3.3 DLQ entry schema

All DLQ entries use the same shape:
```
XADD events:vici2.dlq.{worker} * \
  source_queue  "vici2:queue:{worker}" \  (or source_stream for stream-based workers)
  source_id     "{job_id or stream_id}" \
  payload       "{JSON-encoded job data}" \
  error         "{error message}" \
  attempt       "{N}" \
  ts            "{unix_ms}"
```

This allows a future DLQ replay worker to deserialize any entry, re-enqueue it, and emit a `vici2.dlq.replayed` audit event.

### 3.4 DLQ monitoring

O01 HANDOFF §2.3 owed list includes E05 metrics. W01 extends this: each DLQ stream should be monitored via:
- Gauge `vici2_worker_dlq_depth{worker}` — polled every 60s via `XLEN events:vici2.dlq.*`.
- Alert: `vici2_worker_dlq_depth{worker} > 0` for 5 min → `warn`; `> 10` for 5 min → `page`.

---

## 4. Observability Contract (O01 HANDOFF §2.1)

### 4.1 Existing metrics in workers

`workers/src/index.ts` registers `vici2_workers_heartbeats_total` and `vici2_workers_uptime_seconds`. These are stub metrics.

`workers/recording-uploader/src/metrics.ts` registers a comprehensive set: `vici2_recording_upload*`, `vici2_recording_sha256*`, `vici2_recording_local_deleted*`, `vici2_recording_queue_depth`, etc. Naming convention: `vici2_recording_*`. All comply with O01's `vici2_{subsystem}_{unit}` convention.

`workers/src/jobs/callback-fire/metrics.ts` — exists, referenced by D06 PLAN §14.

`workers/recording-uploader/src/index.ts` exposes `/metrics` on `env.R02_METRICS_PORT` (default inferred from env). Prometheus scrapes this.

### 4.2 Required BullMQ metrics

BullMQ does not automatically expose Prometheus metrics. The workers package must implement:

| Metric | Type | Labels | Source |
|---|---|---|---|
| `vici2_bullmq_jobs_active` | Gauge | `queue` | `Queue.getActiveCount()` |
| `vici2_bullmq_jobs_waiting` | Gauge | `queue` | `Queue.getWaitingCount()` |
| `vici2_bullmq_jobs_delayed` | Gauge | `queue` | `Queue.getDelayedCount()` |
| `vici2_bullmq_jobs_failed` | Gauge | `queue` | `Queue.getFailedCount()` |
| `vici2_bullmq_jobs_completed` | Gauge | `queue` | `Queue.getCompletedCount()` |
| `vici2_bullmq_job_duration_seconds` | Histogram | `queue`, `status` | measured in processor |
| `vici2_bullmq_job_attempts_total` | Counter | `queue`, `outcome` | Worker events |
| `vici2_worker_dlq_depth` | Gauge | `worker` | XLEN on dlq streams |

These should be collected in a shared `workers/src/lib/metrics.ts` module and polled every 30s. The `/metrics` endpoint is served by the existing HTTP server in each worker process.

### 4.3 Per-job timing

Each BullMQ processor should record:
- `job.processedOn - job.timestamp` = queue wait time (latency)
- `job.finishedOn - job.processedOn` = execution time

These are available from BullMQ job properties after completion. W01 mandates that every processor records these as histograms labeled by queue name.

### 4.4 O01 Prometheus scrape targets

O01 HANDOFF §1.1 mentions workers expose metrics on port 9103 (per F01 HANDOFF). With the two-package layout:
- `@vici2/workers`: port 9103
- `@vici2/recording-uploader`: needs its own port — currently `env.R02_METRICS_PORT`. W01 proposes port 9104.

Both must be declared as scrape targets in `infra/observability/prometheus/prometheus.yml`.

---

## 5. Trace Propagation

### 5.1 Current state

No distributed tracing is implemented (O01 HANDOFF §4 explicitly defers OTel to Phase 2). However, the W3C Traceparent header (`traceparent: 00-{traceId}-{spanId}-{flags}`) is a lightweight, zero-dependency mechanism to correlate job execution across services without a full OTel collector.

### 5.2 W3C traceparent via job.opts.tracecontext

BullMQ supports arbitrary fields in `job.opts`. Convention: enqueue jobs with:
```typescript
queue.add(name, data, {
  tracecontext: {
    traceparent: req.headers.traceparent,  // forwarded from HTTP request
    tracestate:  req.headers.tracestate,
  }
});
```
Processors read `job.opts.tracecontext?.traceparent` and set it as `X-B3-TraceId` or equivalent on any downstream HTTP calls (API callbacks) or Pino log fields. This allows correlation without full OTel instrumentation.

W01 mandates: every job enqueue in the API layer MUST forward the `traceparent` header into `job.opts.tracecontext`. Every processor MUST log `{ traceparent }` at INFO level on job start.

Phase 2: when OTel ships, processors become OTel spans; the `tracecontext` field becomes the OTel context carrier.

### 5.3 ULID idempotency keys

F05 HANDOFF §6 mentions deferred items: `Password reset endpoints (W01) not yet shipped`. This refers to a future email-delivery worker that W01 will define the queue for. All workers must carry a ULID idempotency key in job data to prevent duplicate processing. D02 PLAN §0 bullet 4 already establishes this pattern (`ulid(importId + ':batch:' + batchIndex)`). W01 formalizes: every job that touches the DB or external API MUST carry an idempotency key.

---

## 6. Graceful Shutdown Analysis

### 6.1 Existing patterns

**`workers/src/index.ts`**: calls `server.close(() => process.exit(0))`. Does NOT close BullMQ workers. This means in-flight jobs are abandoned on SIGTERM. **Bug to fix.**

**`workers/recording-uploader/src/index.ts`**: Calls `consumer.stop()` (stops XREADGROUP loop), then `uploadWorker.close()` and `deleteLocalWorker.close()` (BullMQ graceful close — waits for in-flight jobs to complete up to a timeout), then `prisma.$disconnect()`, then `metricsServer.close()`. Order is correct.

**`workers/src/jobs/callback-fire/index.ts`**: Calls `clearInterval()` on all intervals, then `prisma.$disconnect()`, then `redis.disconnect()`, then `process.exit(0)`. No BullMQ workers to close (it's setInterval-based). Correct.

### 6.2 BullMQ graceful close semantics

`Worker.close(force?)`:
- Without `force`: waits for in-flight jobs to complete, then stops accepting new jobs. Default timeout: none (waits indefinitely). For production: pass a timeout.
- With `force: true`: immediately stops; in-flight jobs are marked stalled and re-queued.

W01 mandates: every Worker.close() call MUST use a timeout:
```typescript
await worker.close(false);  // graceful
setTimeout(() => worker.close(true), 30_000);  // force after 30s
```
Or equivalently, use a single `close()` with a `WORKER_SHUTDOWN_TIMEOUT_MS` env var (default 30000).

### 6.3 SIGTERM vs SIGKILL

Kubernetes sends SIGTERM, then waits `terminationGracePeriodSeconds` (default 30s), then sends SIGKILL. Docker compose sends SIGTERM then waits `stop_grace_period` (default 10s). W01 recommends:
- `stop_grace_period: 60s` in docker-compose for workers
- K8s `terminationGracePeriodSeconds: 60`
- Worker shutdown timeout: 50s (leaves 10s for process cleanup)

For the lead-import worker (long-running sandboxed CSV processor): `stop_grace_period: 300s` (5 min) because a 1M-row import can take 17 min. The in-progress checkpoint (`row_count_processed`) allows resume after SIGKILL.

### 6.4 No new jobs during shutdown

After SIGTERM:
1. Stop BullMQ Worker from accepting new jobs (`worker.pause()` or begin the close sequence).
2. Allow in-flight jobs to complete up to the timeout.
3. Prometheus `/metrics` and `/health` endpoints: `/ready` should return 503 immediately to signal to load balancers. `/health` continues returning 200 until process exits (distinguishes liveness from readiness).

---

## 7. Health and Readiness Endpoints

### 7.1 Current state

`workers/src/index.ts`: `/health` returns `{ status: 'ok', service: 'workers' }`. No `/ready` endpoint.
`workers/recording-uploader/src/index.ts`: `/health` returns `{ status: 'ok', service: 'recording-uploader' }`. No `/ready` endpoint.

### 7.2 Health vs Readiness distinction

| Endpoint | Meaning | K8s use |
|---|---|---|
| `/health` (liveness) | Process is alive; restart if this fails | `livenessProbe` — fail → container restart |
| `/ready` (readiness) | Process is ready to accept work | `readinessProbe` — fail → removed from LB pool, not restarted |
| `/metrics` | Prometheus scrape | scrapeConfig |

For workers, readiness means:
- BullMQ Worker is connected to Valkey.
- Prisma connection pool has at least 1 open connection.
- (For recording-uploader) S3 backend is reachable.
- (For stream-based workers) Stream consumer group exists.

### 7.3 Proposed /ready checks

```typescript
GET /ready
→ 200 { ready: true, checks: { valkey: 'ok', db: 'ok' } }
→ 503 { ready: false, checks: { valkey: 'ok', db: 'error', error: '...' } }
```

Checks should be async with timeout (e.g. 2s). Failures are logged at WARN. The endpoint caches the last result for 5s to avoid hammering the DB on every K8s probe interval.

---

## 8. Deployment Architecture

### 8.1 Phase 1: docker-compose

F01 docker-compose currently has one `workers` service (`workers/Dockerfile`). The Dockerfile is a single-stage build. R02's recording-uploader is a separate package, suggesting it needs its own service.

`workers/Dockerfile` (current):
```dockerfile
FROM node:20-alpine
WORKDIR /app
# ... (not read in this session — inferred from package.json scripts)
CMD ["node", "dist/index.js"]
```

The recording-uploader is a separate package with its own build (`workers/recording-uploader/`). It likely needs its own docker-compose service.

W01 proposes the following docker-compose services:
- `workers` — runs `@vici2/workers` (lead-import, callback-fire, recording-log-writer, audit-attest, DNC workers)
- `recording-uploader` — runs `@vici2/recording-uploader` (R02)

Both services share the same `workers/` volume context but use different entry points.

### 8.2 Phase 4: Kubernetes

Per F02 PLAN §0 bullet 10 (K8s Phase 4), workers deploy as separate K8s Deployments. Each worker type becomes a Deployment with:
- `replicas: 1` (Phase 1 equivalent)
- `HorizontalPodAutoscaler` based on `vici2_bullmq_jobs_waiting` gauge (Phase 4)
- `resources.requests` and `resources.limits` appropriate to the workload

For Phase 4 K8s layout:
- `deployment/workers-lead-import.yaml`
- `deployment/workers-callback-fire.yaml`
- `deployment/workers-recording-log-writer.yaml`
- `deployment/workers-recording-uploader.yaml`
- `deployment/workers-audit-attest.yaml`
- `deployment/workers-dnc-sync.yaml`

### 8.3 Why separate docker-compose services?

1. Independent scaling: recording-uploader is CPU + network I/O bound (SHA-256 + S3 upload); lead-import is CPU bound (CSV parsing). Different resource profiles.
2. Independent restart: a crash in recording-uploader doesn't restart lead-import workers.
3. Independent Prometheus scrape targets: different ports, different metric sets.
4. NFS dependency: recording-uploader needs the NFS mount of FS recordings volume; other workers don't. Separating avoids NFS mount failure blocking all workers.

---

## 9. Worker Pool Sizing

### 9.1 Per-queue concurrency × replica analysis

| Queue | Concurrency/pod | Phase 1 Replicas | Total concurrency | Bottleneck |
|---|---|---|---|---|
| `vici2:queue:lead-import` | 2 | 1 | 2 | CSV pipeline + DB writer (I/O) |
| `vici2:queue:recording-upload` | 10 | 1 | 10 | S3 PutObject (network) |
| `vici2:queue:recording-delete-local` | 5 | 1 | 5 | fs.unlink (disk I/O) |
| `vici2:queue:recording-log-writer` | N/A (stream) | 1 | 1 | DB INSERT (I/O) |
| `vici2:queue:callback-fire` | N/A (tick) | 1 | 1 | Valkey lock (advisory) |
| `vici2:queue:audit-attest` | 1 | 1 | 1 | S3 PUT + DB (nightly) |
| `vici2:queue:federal-dnc-sync` | 1 | 1 | 1 | FTP download + Bloom load |
| `vici2:queue:state-dnc-sync` | 1 | 1 | 1 | FTP download + Bloom load |
| `vici2:queue:freeswitch-event-router` | N/A (stream) | 1 | 1 | ESL event fan-out |

### 9.2 Memory budget per pod

Node.js 20 base RSS: ~30 MB.
- lead-import worker: +CSV pipeline peak ~47 MB (per D02 PLAN §2.3) → ~80 MB total. Safe on 256 MB limit.
- recording-uploader: +4 parts × 16 MB × 10 concurrent = 640 MB peak → 1 GB limit.
- Other workers: < 100 MB total.

### 9.3 MySQL connection pool

F02 PLAN §0 bullet 9: workers allocated 4 jobs × 5 connections = 20 connections. With W01's revised concurrency:
- `@vici2/workers` (lead-import concurrency=2): 2 × 5 = 10 connections.
- `@vici2/recording-uploader` (upload concurrency=10, delete concurrency=5): 15 × 2 = 30 connections (DB writes are quick; connection borrowing is acceptable).
- Total workers: ~40 connections. Well within `max_connections=500`.

Prisma connection_limit should be set explicitly:
- `@vici2/workers`: `DATABASE_URL` + `?connection_limit=15`
- `@vici2/recording-uploader`: `DATABASE_URL` + `?connection_limit=20`

### 9.4 Valkey connection pool

Each BullMQ Worker requires 2 ioredis connections (one for blocking ops, one for non-blocking). Plus the stream consumers add 1 each.
- `@vici2/workers` with 5 worker types: ~12 ioredis connections.
- `@vici2/recording-uploader`: 3 connections (upload worker, delete worker, stream consumer).
- Total: ~15 connections. Valkey handles up to 10,000; this is trivial.

---

## 10. Idempotency Contract

### 10.1 Why idempotency is mandatory

Workers run in an at-least-once delivery model (BullMQ `BRPOPLPUSH` semantics for active job tracking). A job can be executed more than once if:
1. The worker crashes after `job.processedOn` is set but before `job.finishedOn`.
2. The lock expires (lockDuration exceeded) and the job is marked stalled.
3. BullMQ retry on failure re-executes the job handler.

Without idempotency, double-processing causes duplicate DB rows, double S3 uploads, double audit events, etc.

### 10.2 Idempotency mechanisms observed

- D02: ULID key `ulid(importId + ':batch:' + batchIndex)` + Valkey 24h cache in D01.
- R02: BullMQ `jobId: recordingLogId.toString()` (BullMQ deduplicates active jobs by jobId) + `WHERE storage_url IS NULL` DB CAS.
- Recording-log-writer: MySQL `ON DUPLICATE KEY UPDATE updated_at = updated_at`.
- Audit-attest: MySQL `INSERT IGNORE` + UNIQUE KEY `(tenant_id, table_name, window_date)`.
- Callback-fire: Prisma `$transaction` with `WHERE status='PENDING'` CAS (P2025 on miss = idempotent skip).

### 10.3 W01 idempotency standard

Every job MUST implement idempotency via at least ONE of:
1. BullMQ `jobId` deduplication (prevents duplicate active jobs)
2. DB `ON DUPLICATE KEY UPDATE` or `INSERT IGNORE`
3. DB `WHERE <condition>` CAS that no-ops on repeat
4. Application-level Valkey key (`SET NX EX`)

All four mechanisms together provide defense-in-depth. W01 mandates that the job idempotency mechanism is documented in the job's source file header comment.

---

## 11. Cron Job Topology

### 11.1 Currently defined cron-type jobs

| Worker | Schedule | Mechanism | Source |
|---|---|---|---|
| audit-attest | `30 3 * * *` UTC (daily) | External cron invocation | C03 audit-attest/index.ts comment |
| callback-fire tick | Every 30s | `setInterval` | D06 callback-fire/index.ts |
| callback-upcoming tick | Every 60s | `setInterval` | D06 callback-fire/index.ts |
| callback-stale tick | Every 5 min | `setInterval` | D06 callback-fire/index.ts |
| recording-upload sweeper | Every 5 min | `setInterval` | R02 recording-uploader/index.ts |
| federal-dnc-sync | Weekly | BullMQ repeatable (per D05 PLAN) | D05 (not yet implemented) |
| state-dnc-sync | Monthly | BullMQ repeatable (per D05 PLAN) | D05 (not yet implemented) |

### 11.2 Repeatable job management

BullMQ repeatable jobs must be initialized at startup (via `Queue.add` with repeat options). They are idempotent if the same `{ pattern, name }` is added twice — BullMQ deduplicates by repeat key. The repeat key should be deterministic (`{ pattern: '30 3 * * *', jobId: 'audit-attest-v1' }`).

### 11.3 Coordination with O02 backup windows

O02 HANDOFF §2.1: DDL window is 02:00–02:30 UTC. O02 backup MySQL runs at 02:00 UTC. Cron jobs that do heavy DB writes should avoid this window:
- audit-attest at 03:30 UTC (safe).
- federal-dnc-sync: Sunday 04:00 UTC (safe).
- state-dnc-sync: 1st of month 04:30 UTC (safe).

---

## 12. RBAC in Workers

### 12.1 wrapJob pattern

`workers/src/wrapJob.ts` provides `wrapJob(opts, handler)` which checks `Can(auth, verb, scope)` at dequeue time. This provides defense-in-depth: even if a job was enqueued with incorrect permissions (e.g., by a test script), the worker enforces RBAC before processing.

The `buildAuth` function must hydrate the auth context from job data (typically from DB: `SELECT role, tenant_id FROM users WHERE id = ?`). This requires a DB call per job but is acceptable — it reads a cached or warm row.

### 12.2 Internal jobs (no user context)

Some jobs are not user-triggered (audit-attest, DNC sync, callback-fire tick, recording-log-writer). These run as a system actor. W01 defines a system actor convention:
- `actor_kind: 'worker'`
- `actor_user_id: null`
- `tenant_id`: explicit from job data or `VICI2_TENANT_ID` env var.

The `wrapJob` wrapper is optional for system jobs; it is mandatory for user-triggered jobs (lead-import, etc.).

### 12.3 JWT for worker→API callbacks

F05 HANDOFF §6 lists "Password reset (email delivery not yet shipped; bootstrap is the workaround)" as a deferred item pointing to W01. This implies W01 may implement a mailer/email-delivery worker. For worker→API callbacks, the worker must present a service JWT (not a user JWT). F05's JWKS endpoint (`/auth/.well-known/jwks.json`) allows any holder of the EdDSA private key to mint tokens. A service JWT convention:
```json
{
  "iss": "vici2-api",
  "aud": "internal",
  "sub": "worker:{workerName}",
  "tenant_id": 1,
  "role": "integrator",
  "iat": ...,
  "exp": ...,
  "jti": "..."
}
```
This is minted by the workers package at startup using `VICI2_JWT_PRIVATE_KEY_JWK` env var. The API validates the `aud: "internal"` claim via a separate middleware.

---

## 13. File Structure Analysis

### 13.1 Current structure

```
workers/
├── Dockerfile
├── package.json                  # @vici2/workers
├── tsconfig.json
├── vitest.config.ts              # includes: test/**/*.test.ts
├── src/
│   ├── index.ts                  # Entry point (stub)
│   ├── wrapJob.ts                # RBAC wrapper
│   └── jobs/
│       ├── lead-import/          # D02
│       ├── callback-fire/        # D06
│       ├── recording-log-writer/ # R01
│       └── audit-attest/         # C03
├── test/
│   └── callback-fire/
│       └── tick.test.ts
└── recording-uploader/           # @vici2/recording-uploader (R02)
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts
    │   ├── stream-consumer.ts
    │   ├── sweeper.ts
    │   ├── config.ts
    │   ├── metrics.ts
    │   ├── backends/
    │   ├── jobs/
    │   └── services/
    └── __tests__/
```

### 13.2 Missing shared infrastructure

The following cross-cutting concerns have no shared module:
1. **Shutdown manager**: Each worker implements its own shutdown logic. A shared `ShutdownManager` class would standardize drain-then-exit.
2. **Metrics registry**: Each worker creates its own `prom-client.Registry`. A shared module would prevent metric name collisions.
3. **DLQ writer**: Each worker manually XADDs to the DLQ stream. A shared `DlqWriter` would enforce consistent entry schema.
4. **Health/Readiness server**: Each worker implements its own HTTP server. A shared `WorkerHttpServer` would standardize `/health`, `/ready`, `/metrics`.
5. **Jitter backoff**: No shared jitter utility.
6. **Trace propagation**: No shared `readTraceparent` / `propagateTraceparent` utility.

W01 proposes creating `workers/src/lib/` with these shared modules.

---

## 14. Inter-Worker Communication Patterns

### 14.1 Observed patterns

- **Stream fan-out** (R01 → R02): T01 writes `events:vici2.recording.stopped`. R01's recording-log-writer subscribes (consumer group `recording-log-writer`). R02's stream consumer subscribes (consumer group `r02-uploader`). Same event, two independent consumers.

- **BullMQ chain** (R02 internal): Stream consumer enqueues `recording-upload` BullMQ job. On failure, `failed` event handler enqueues to `recording-upload-dlq`.

- **Valkey advisory lock** (D06): `SET NX EX 60` prevents multi-pod double-fire.

- **DB poll** (D06): `findMany WHERE status='PENDING' AND callbackAt <= NOW() + grace`. Classic polling, not event-driven.

### 14.2 The freeswitch-event-router queue

D02 PLAN references `federal-dnc-sync` and `state-dnc-sync`. D06 PLAN references `callback-fire`, `callback-upcoming`, `callback-stale`. R01 references `recording-log-writer`. R02 references `recording-upload`, `recording-delete-local`.

The full queue topology from all consuming modules:

| Queue name | Consumer module | Pattern |
|---|---|---|
| `vici2:queue:lead-import` | D02 | BullMQ Worker (sandboxed) |
| `vici2:queue:recording-upload` | R02 | BullMQ Worker |
| `vici2:queue:recording-delete-local` | R02 | BullMQ Worker |
| `vici2:queue:recording-log-writer` | R01 | Redis Streams XREADGROUP |
| `vici2:queue:callback-fire` | D06 | setInterval + Valkey lock |
| `vici2:queue:callback-upcoming` | D06 | setInterval + Valkey lock |
| `vici2:queue:callback-stale` | D06 | setInterval + Valkey lock |
| `vici2:queue:audit-attest` | C03 | BullMQ repeatable |
| `vici2:queue:federal-dnc-sync` | D05 | BullMQ repeatable |
| `vici2:queue:state-dnc-sync` | D05 | BullMQ repeatable |
| `vici2:queue:freeswitch-event-router` | T01 | Redis Streams XREADGROUP |

### 14.3 freeswitch-event-router

T01 (ESL bridge) consumes FreeSWITCH events and routes them to Valkey streams (`events:vici2.call.*`, `events:vici2.recording.*`, etc.). This is referenced as a worker queue in W01's scope because the worker must coordinate its deployment with T01's Go component. The Node-side freeswitch-event-router is a stream consumer that bridges ESL events to downstream Node consumers (R01's recording-log-writer, S01's wallboard, etc.). It sits in `@vici2/workers` as a stream consumer job.

---

## 15. Schema Impact Assessment

### 15.1 No MySQL schema additions expected

BullMQ uses Valkey exclusively for job state. No MySQL tables are added by W01 itself. The DLQ uses Valkey streams. MySQL additions are owned by the individual module plans (D02: `imports`, `import_errors`; etc.).

### 15.2 Valkey keyspace additions

W01 adds the following Valkey keys (beyond existing per-module keys):

| Key pattern | Type | Purpose | TTL |
|---|---|---|---|
| `events:vici2.dlq.*` | Stream | Per-worker DLQ | 30d via MAXLEN ~ 10000 |
| `vici2:worker:health:{worker}` | HASH | Cached readiness check result | 5s |

All other BullMQ keys (`bull:*`) are managed by BullMQ itself under the queue names.

---

## 16. Open Questions Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | BullMQ queue prefix convention | Full name `vici2:queue:{worker}`; no BullMQ `prefix` option |
| 2 | DLQ: BullMQ queue vs Valkey stream | Valkey stream `events:vici2.dlq.{worker}`; consistent with event bus |
| 3 | Two packages or one | Two packages retained; `recording-uploader` stays separate (different deps, NFS mount) |
| 4 | Sandboxed processor: which jobs? | Only lead-import (CPU-bound CSV); others are I/O-bound (in-thread) |
| 5 | /ready endpoint required? | Yes — separate from /health; returns 503 during shutdown |
| 6 | Graceful shutdown timeout | 50s drain + force after 60s for most workers; 300s for lead-import |
| 7 | MySQL connection limits | workers: 15; recording-uploader: 20; total ~40, well within 500 max |
| 8 | Cron mechanism | BullMQ repeatable for nightly/weekly jobs; setInterval for sub-minute ticks |
| 9 | Metrics port allocation | @vici2/workers: 9103; @vici2/recording-uploader: 9104 |
| 10 | Worker→API JWT convention | `aud: "internal"`, `role: "integrator"`, signed with VICI2_JWT_PRIVATE_KEY_JWK |
| 11 | Trace propagation | W3C traceparent in job.opts.tracecontext; logged on job start |
| 12 | Shared lib modules | Create workers/src/lib/: shutdown.ts, health-server.ts, dlq-writer.ts, metrics.ts, backoff.ts, tracing.ts |

---

## 17. Risks Identified

| Risk | Likelihood | Impact |
|---|---|---|
| `workers/src/index.ts` does not drain BullMQ on SIGTERM | High (current bug) | In-flight lead-import jobs lost |
| Recording-uploader NFS mount failure blocks S3 upload workers | Medium | Recording upload queue backlog |
| Thundering-herd on BullMQ retry without jitter | Medium | Valkey / DB spike after S3 outage |
| DLQ stream grows unbounded (MAXLEN not set) | Low | Valkey memory pressure |
| Lead-import sandboxed processor not yet implemented | High | D02 PLAN calls for it; current code uses in-thread |
| Multi-tenant support deferred (single VICI2_TENANT_ID env var) | High (by design) | Phase 4 multi-tenant requires refactor |
| wrapJob.ts references `@vici2/auth/rbac` which doesn't exist in workers package.json | High | Build failure when wrapJob is used |
| BullMQ lockDuration > job duration causes premature staleness | Low | Unlikely at current job durations |

---

*End of W01 RESEARCH.md*
