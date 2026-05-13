/**
 * workers/recording-uploader/src/backends/factory.ts
 *
 * makeBackend() — instantiates the correct StorageBackend from env vars.
 * R02 PLAN §4.1.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { S3Backend } from './s3.js';
import { makeMinioBackend } from './minio.js';
import { makeR2Backend } from './r2.js';
import { makeB2Backend } from './b2.js';
import type { StorageBackend } from './types.js';
import type { Env } from '../config.js';

export function makeBackend(env: Env): StorageBackend {
  switch (env.R02_STORAGE_BACKEND) {
    case 's3': {
      const client = new S3Client({
        region: env.R02_S3_REGION,
        endpoint: env.R02_S3_ENDPOINT,
        forcePathStyle: env.R02_S3_FORCE_PATH_STYLE,
        credentials:
          env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
      return new S3Backend(client);
    }

    case 'minio':
      return makeMinioBackend({
        endpoint: env.R02_S3_ENDPOINT ?? 'http://localhost:9000',
        region: env.R02_S3_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      });

    case 'r2': {
      const accountId = process.env['CF_ACCOUNT_ID'] ?? '';
      return makeR2Backend({
        accountId,
        endpoint: env.R02_S3_ENDPOINT,
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
        region: env.R02_S3_REGION,
      });
    }

    case 'b2':
      return makeB2Backend({
        endpoint: env.R02_S3_ENDPOINT ?? '',
        region: env.R02_S3_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
      });
  }
}
