/**
 * workers/recording-uploader/src/backends/s3.ts
 *
 * S3Backend — AWS S3 (default). SSE-KMS + Object Lock Compliance.
 * R02 PLAN §4.2, §4.3, §5.
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectLegalHoldCommand,
  GetObjectCommand,
  type ObjectLockLegalHoldStatus,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutOptions, HeadResult, StorageBackend } from './types.js';

const MULTIPART_PART_SIZE = 16 * 1024 * 1024; // 16 MB
const MULTIPART_QUEUE_SIZE = 4; // concurrent parts

export class S3Backend implements StorageBackend {
  readonly name = 's3';
  readonly client: S3Client;

  constructor(client: S3Client) {
    this.client = client;
  }

  async putObject(opts: PutOptions): Promise<void> {
    const cmd = new PutObjectCommand({
      Bucket: opts.bucket,
      Key: opts.key,
      Body: opts.body as Buffer,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
      ServerSideEncryption: opts.kmsKeyId ? 'aws:kms' : undefined,
      SSEKMSKeyId: opts.kmsKeyId,
      BucketKeyEnabled: opts.kmsKeyId ? true : undefined,
      ObjectLockMode: opts.objectLockRetainUntilDate ? 'COMPLIANCE' : undefined,
      ObjectLockRetainUntilDate: opts.objectLockRetainUntilDate,
      Metadata: opts.metadata,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: opts.checksumSha256,
    });
    await this.client.send(cmd);
  }

  async putObjectMultipart(opts: PutOptions): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: opts.bucket,
        Key: opts.key,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: opts.body as any,
        ContentType: opts.contentType,
        ServerSideEncryption: opts.kmsKeyId ? 'aws:kms' : undefined,
        SSEKMSKeyId: opts.kmsKeyId,
        BucketKeyEnabled: opts.kmsKeyId ? true : undefined,
        ObjectLockMode: opts.objectLockRetainUntilDate ? 'COMPLIANCE' : undefined,
        ObjectLockRetainUntilDate: opts.objectLockRetainUntilDate,
        Metadata: opts.metadata,
      },
      partSize: MULTIPART_PART_SIZE,
      queueSize: MULTIPART_QUEUE_SIZE,
    });
    await upload.done();
  }

  async headObject(bucket: string, key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        contentLength: res.ContentLength ?? 0,
        checksumSha256: res.ChecksumSHA256,
        clientSha256: res.Metadata?.['client-sha256'],
        objectLockMode: res.ObjectLockMode,
        objectLockRetainUntilDate: res.ObjectLockRetainUntilDate,
        legalHold: res.ObjectLockLegalHoldStatus === 'ON',
      };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async putLegalHold(bucket: string, key: string, on: boolean): Promise<void> {
    const status: ObjectLockLegalHoldStatus = on ? 'ON' : 'OFF';
    await this.client.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: key,
        LegalHold: { Status: status },
      }),
    );
  }

  async getSignedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    return awsGetSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { name?: string; Code?: string }).name ??
    (err as { name?: string; Code?: string }).Code;
  return code === 'NotFound' || code === 'NoSuchKey' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}
