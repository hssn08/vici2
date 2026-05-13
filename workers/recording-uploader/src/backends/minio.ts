/**
 * workers/recording-uploader/src/backends/minio.ts
 *
 * MinioBackend — dev + on-prem. Uses S3Backend with forcePathStyle=true.
 * R02 PLAN §4.1. MinIO does not support Object Lock in all configurations;
 * ObjectLockRetainUntilDate and legal holds are sent but may be ignored
 * silently in dev environments.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { S3Backend } from './s3.js';
import type { StorageBackend } from './types.js';

export function makeMinioBackend(opts: {
  endpoint: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): StorageBackend {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? 'us-east-1',
    forcePathStyle: true,
    credentials:
      opts.accessKeyId && opts.secretAccessKey
        ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
        : undefined,
  });
  const backend = new S3Backend(client);
  // Override name to reflect it's minio
  return Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
    name: 'minio',
  }) as StorageBackend;
}
