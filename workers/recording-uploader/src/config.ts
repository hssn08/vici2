/**
 * workers/recording-uploader/src/config.ts
 *
 * Zod-validated environment variables + per-tenant settings cache (60 s TTL).
 * R02 PLAN §7.3 + §6.3.
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

  // Storage backend: s3 | r2 | b2 | minio
  R02_STORAGE_BACKEND: z.enum(['s3', 'r2', 'b2', 'minio']).default('minio'),

  // S3 / MinIO endpoint (required for r2, b2, minio; optional for aws s3)
  R02_S3_ENDPOINT: z.string().optional(),
  R02_S3_REGION: z.string().default('us-east-1'),
  R02_S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  // Default bucket (overridable per-tenant via tenants.settings.recording_bucket)
  R02_DEFAULT_BUCKET: z.string().default('vici2-recordings-dev'),

  // AWS credentials (injected by IAM role or env in dev)
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // Worker concurrency
  R02_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

  // Metrics port
  R02_METRICS_PORT: z.coerce.number().int().default(9104),

  // Sweeper interval (seconds)
  R02_SWEEPER_INTERVAL_SEC: z.coerce.number().int().default(300),

  // Recording minimum duration in seconds (shorter recordings are marked too_short)
  R02_MIN_DURATION_SEC: z.coerce.number().int().default(2),

  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Per-tenant settings shape (read from tenants.settings JSON column)
// ---------------------------------------------------------------------------

export const TenantSettingsSchema = z.object({
  recording_backend: z.enum(['s3', 'r2', 'b2', 'minio']).optional(),
  recording_bucket: z.string().optional(),
  recording_prefix: z.string().optional(),
  recording_retention_years: z.number().int().min(5).max(99).default(7),
  kms_key_arn: z.string().optional(),
  recording_secondary_opus: z.boolean().default(false),
  consent_declined_grace_minutes: z.number().int().min(0).max(60).default(5),
});

export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

// ---------------------------------------------------------------------------
// Simple TTL cache for tenant settings (60 s)
// ---------------------------------------------------------------------------

interface CacheEntry {
  settings: TenantSettings;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<bigint, CacheEntry>();

export function getCachedSettings(tenantId: bigint): TenantSettings | undefined {
  const entry = cache.get(tenantId);
  if (entry && entry.expiresAt > Date.now()) return entry.settings;
  cache.delete(tenantId);
  return undefined;
}

export function setCachedSettings(tenantId: bigint, settings: TenantSettings): void {
  cache.set(tenantId, { settings, expiresAt: Date.now() + CACHE_TTL_MS });
}
