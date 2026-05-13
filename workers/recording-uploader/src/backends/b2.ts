/**
 * workers/recording-uploader/src/backends/b2.ts
 *
 * B2Backend — Backblaze B2 S3-compatible API.
 * B2 does not support SSE-KMS (uses native B2 server-side encryption).
 * Object Lock is available on B2 since 2023-09.
 * R02 PLAN §4.1.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { S3Backend } from './s3.js';
import type { StorageBackend } from './types.js';

export function makeB2Backend(opts: {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}): StorageBackend {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? 'us-west-004',
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const backend = new S3Backend(client);
  return Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
    name: 'b2',
  }) as StorageBackend;
}
