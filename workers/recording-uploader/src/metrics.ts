/**
 * workers/recording-uploader/src/metrics.ts
 *
 * Prometheus metrics for R02 — recording upload pipeline.
 * R02 PLAN §15.
 */

import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'vici2_recording_uploader_' });

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const uploadedTotal = new client.Counter({
  name: 'vici2_recording_uploaded_total',
  help: 'Successful recording uploads to object storage.',
  labelNames: ['tenant_id', 'backend', 'multipart'] as const,
  registers: [registry],
});

export const uploadFailuresTotal = new client.Counter({
  name: 'vici2_recording_upload_failures_total',
  help: 'Recording upload failures by reason.',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [registry],
});

export const uploadRetriesTotal = new client.Counter({
  name: 'vici2_recording_upload_retries_total',
  help: 'Per-BullMQ-attempt retry counts.',
  labelNames: ['tenant_id', 'attempt'] as const,
  registers: [registry],
});

export const uploadDlqTotal = new client.Counter({
  name: 'vici2_recording_upload_dlq_total',
  help: 'Terminal DLQ entries.',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [registry],
});

export const consentSkippedTotal = new client.Counter({
  name: 'vici2_recording_consent_skipped_total',
  help: 'Consent-declined no-upload decisions.',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [registry],
});

export const localDeletedTotal = new client.Counter({
  name: 'vici2_recording_local_deleted_total',
  help: 'Sweeper local file unlinks.',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const sweeperErrorsTotal = new client.Counter({
  name: 'vici2_recording_sweeper_errors_total',
  help: 'Sweeper failures.',
  labelNames: ['error_code'] as const,
  registers: [registry],
});

export const legalHoldAppliedTotal = new client.Counter({
  name: 'vici2_recording_legal_hold_applied_total',
  help: 'Legal holds set.',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const presignedUrlGeneratedTotal = new client.Counter({
  name: 'vici2_recording_presigned_url_generated_total',
  help: 'Pre-signed URLs minted.',
  labelNames: ['tenant_id', 'requester_role'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export const uploadDurationSeconds = new client.Histogram({
  name: 'vici2_recording_upload_duration_seconds',
  help: 'Time to upload a recording to object storage.',
  labelNames: ['tenant_id', 'size_bucket'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 300],
  registers: [registry],
});

export const sha256DurationSeconds = new client.Histogram({
  name: 'vici2_recording_sha256_duration_seconds',
  help: 'Time to stream-hash a recording file.',
  labelNames: ['tenant_id', 'size_bucket'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const uploadBytesPerSecond = new client.Histogram({
  name: 'vici2_recording_upload_bytes_per_second',
  help: 'Upload throughput.',
  labelNames: ['tenant_id', 'backend'] as const,
  buckets: [1e6, 5e6, 10e6, 50e6, 100e6],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

export const queueDepth = new client.Gauge({
  name: 'vici2_recording_queue_depth',
  help: 'BullMQ queue depth.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const workersActive = new client.Gauge({
  name: 'vici2_recording_workers_active',
  help: 'Active upload workers.',
  labelNames: ['worker_id'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sizeBucket(bytes: number): 'small' | 'medium' | 'large' {
  if (bytes <= 16 * 1024 * 1024) return 'small';
  if (bytes <= 100 * 1024 * 1024) return 'medium';
  return 'large';
}
