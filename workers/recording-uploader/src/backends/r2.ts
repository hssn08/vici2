/**
 * workers/recording-uploader/src/backends/r2.ts
 *
 * R2Backend — Cloudflare R2. S3-compatible; no SSE-KMS (R2 manages keys).
 * Object Lock: R2 supports Object Lock as of 2024-10; COMPLIANCE mode available.
 * R02 PLAN §4.1.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { S3Backend } from './s3.js';
import type { StorageBackend } from './types.js';

export function makeR2Backend(opts: {
  accountId: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}): StorageBackend {
  const endpoint = opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    endpoint,
    region: opts.region ?? 'auto',
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const backend = new S3Backend(client);
  return Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
    name: 'r2',
  }) as StorageBackend;
}
