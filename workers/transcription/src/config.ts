/**
 * workers/transcription/src/config.ts
 *
 * Zod-validated environment variables + per-tenant settings cache (60 s TTL).
 * N07 PLAN §3.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Environment schema
// ---------------------------------------------------------------------------

const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Redis / Valkey
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // S3 / MinIO storage
  N07_S3_ENDPOINT: z.string().optional(),
  N07_S3_REGION: z.string().default('us-east-1'),
  N07_S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  N07_DEFAULT_BUCKET: z.string().default('vici2-recordings-dev'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // Python GPU sidecar
  N07_PYTHON_SIDECAR_URL: z.string().default('http://localhost:8765'),
  N07_PYTHON_SIDECAR_TIMEOUT_MS: z.coerce.number().int().default(300_000), // 5 min

  // Transcription backend: faster_whisper | deepgram | none
  VICI2_TRANSCRIPTION_BACKEND: z.enum(['faster_whisper', 'deepgram', 'none']).default('faster_whisper'),

  // Deepgram API key (only used when backend=deepgram)
  DEEPGRAM_API_KEY: z.string().optional(),

  // BullMQ worker concurrency
  N07_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),

  // Metrics port
  N07_METRICS_PORT: z.coerce.number().int().default(9107),

  // Object Lock retention (years) — default 7
  N07_RETENTION_YEARS: z.coerce.number().int().min(1).max(99).default(7),

  // Max word count for inline transcript response (above this → URL redirect)
  N07_INLINE_WORD_COUNT_LIMIT: z.coerce.number().int().default(5000),

  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Per-tenant settings shape (read from tenants.settings JSON column)
// ---------------------------------------------------------------------------

export const TenantTranscriptionSettingsSchema = z.object({
  transcription_enabled: z.boolean().default(true),
  transcription_model: z.enum(['auto', 'fast', 'economy', 'large']).default('auto'),
  transcription_backend: z.enum(['self-hosted', 'deepgram', 'assemblyai']).default('self-hosted'),
  transcription_lang_hint: z.string().nullable().default(null),
  transcription_retain_raw: z.boolean().default(true),
  transcription_pii_backend: z.enum(['presidio', 'none']).default('presidio'),
  recording_bucket: z.string().optional(),
  kms_key_arn: z.string().optional(),
  recording_retention_years: z.number().int().min(5).max(99).default(7),
});

export type TenantTranscriptionSettings = z.infer<typeof TenantTranscriptionSettingsSchema>;

// ---------------------------------------------------------------------------
// Simple TTL cache for tenant settings (60 s)
// ---------------------------------------------------------------------------

interface CacheEntry {
  settings: TenantTranscriptionSettings;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<bigint, CacheEntry>();

export function getCachedSettings(tenantId: bigint): TenantTranscriptionSettings | undefined {
  const entry = cache.get(tenantId);
  if (entry && entry.expiresAt > Date.now()) return entry.settings;
  cache.delete(tenantId);
  return undefined;
}

export function setCachedSettings(tenantId: bigint, settings: TenantTranscriptionSettings): void {
  cache.set(tenantId, { settings, expiresAt: Date.now() + CACHE_TTL_MS });
}
