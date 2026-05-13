/**
 * workers/transcription/src/metrics.ts
 *
 * Prometheus metrics for N07 — transcription pipeline.
 * N07 PLAN §14 / AC-12.
 */

import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'vici2_transcription_' });

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const completedTotal = new client.Counter({
  name: 'vici2_transcription_completed_total',
  help: 'Successful transcriptions.',
  labelNames: ['tenant_id', 'lang', 'model', 'stereo'] as const,
  registers: [registry],
});

export const failuresTotal = new client.Counter({
  name: 'vici2_transcription_failures_total',
  help: 'Transcription job failures by reason.',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [registry],
});

export const dlqTotal = new client.Counter({
  name: 'vici2_transcription_dlq_total',
  help: 'Terminal DLQ entries after all retries exhausted.',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const consentBlockedTotal = new client.Counter({
  name: 'vici2_transcription_consent_blocked_total',
  help: 'Recordings skipped due to consent status.',
  labelNames: ['tenant_id', 'consent_status'] as const,
  registers: [registry],
});

export const piiRedactedTotal = new client.Counter({
  name: 'vici2_transcription_pii_redacted_total',
  help: 'Number of PII entities redacted.',
  labelNames: ['tenant_id', 'entity_type'] as const,
  registers: [registry],
});

export const retryTotal = new client.Counter({
  name: 'vici2_transcription_retry_total',
  help: 'BullMQ retry attempts.',
  labelNames: ['tenant_id', 'attempt'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export const processingDurationSeconds = new client.Histogram({
  name: 'vici2_transcription_processing_duration_seconds',
  help: 'End-to-end transcription processing time.',
  labelNames: ['model', 'lang', 'stereo', 'size_bucket'] as const,
  buckets: [1, 5, 10, 20, 30, 45, 60, 120, 300],
  registers: [registry],
});

export const downloadDurationSeconds = new client.Histogram({
  name: 'vici2_transcription_download_duration_seconds',
  help: 'WAV download duration from S3.',
  labelNames: ['tenant_id', 'size_bucket'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const uploadDurationSeconds = new client.Histogram({
  name: 'vici2_transcription_upload_duration_seconds',
  help: 'Transcript JSON upload duration to S3.',
  labelNames: ['tenant_id'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const sidecardCallDurationSeconds = new client.Histogram({
  name: 'vici2_transcription_sidecar_call_duration_seconds',
  help: 'Python sidecar HTTP call duration.',
  labelNames: ['model', 'stereo'] as const,
  buckets: [1, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

export const queueDepth = new client.Gauge({
  name: 'vici2_transcription_queue_depth',
  help: 'BullMQ queue depth.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function durationBucket(seconds: number): 'short' | 'medium' | 'long' {
  if (seconds <= 120) return 'short';
  if (seconds <= 600) return 'medium';
  return 'long';
}
