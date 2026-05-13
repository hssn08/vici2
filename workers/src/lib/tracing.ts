/**
 * workers/src/lib/tracing.ts
 *
 * W3C traceparent propagation for BullMQ jobs (PLAN §10).
 *
 * Phase 1: traceparent is passed via job.opts (custom field) and logged at INFO.
 * Phase 2: replace with OTel @opentelemetry/sdk-node span propagation.
 *
 * Contract (FROZEN):
 *   - API enqueue: forward req.headers['traceparent'] in job.opts.tracecontext
 *   - Processor start: call logJobStart() to emit traceparent in structured log
 *   - API callbacks: include traceparent as HTTP header (propagateTraceparent)
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
}

/** Extract the W3C traceparent from job options (FROZEN contract). */
export function extractTraceparent(job: Job): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (job.opts as any)?.tracecontext?.traceparent as string | undefined;
}

/** Extract the full trace context (traceparent + tracestate) from job options. */
export function extractTraceContext(job: Job): TraceContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (job.opts as any)?.tracecontext as TraceContext | undefined;
  return {
    traceparent: ctx?.traceparent,
    tracestate: ctx?.tracestate,
  };
}

/**
 * Emit a structured INFO log line on job start with traceparent.
 * Call this at the very beginning of every job processor function.
 */
export function logJobStart(logger: Logger, job: Job, queueName: string): void {
  logger.info({
    jobId: job.id,
    queue: queueName,
    attempt: job.attemptsMade,
    traceparent: extractTraceparent(job),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tenantId: (job.data as any)?.tenantId,
  }, `${queueName}: job started`);
}

/**
 * Build HTTP headers for outbound API callback calls, forwarding the
 * traceparent from the job so distributed traces are linked.
 */
export function propagateTraceparent(
  job: Job,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const { traceparent, tracestate } = extractTraceContext(job);
  const headers: Record<string, string> = { ...extraHeaders };
  if (traceparent) headers['traceparent'] = traceparent;
  if (tracestate) headers['tracestate'] = tracestate;
  return headers;
}

/**
 * Create a pino child logger with job context bound to every log line.
 * Use this instead of the root logger inside job processors.
 */
export function jobLogger(logger: Logger, job: Job, queueName: string): Logger {
  return logger.child({
    jobId: job.id,
    queue: queueName,
    traceparent: extractTraceparent(job),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tenantId: (job.data as any)?.tenantId,
  });
}
