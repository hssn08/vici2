/**
 * workers/recording-uploader/src/backends/types.ts
 *
 * StorageBackend abstraction — pluggable S3 / R2 / B2 / MinIO.
 * All backends use @aws-sdk/client-s3 v3 with backend-specific endpoint config.
 * R02 PLAN §4.1.
 */

import type { S3Client } from '@aws-sdk/client-s3';

export interface PutOptions {
  bucket: string;
  key: string;
  body: NodeJS.ReadableStream | Buffer;
  contentType: string;
  contentLength: number;
  /** SSE-KMS key ARN or alias */
  kmsKeyId?: string;
  /** Per-object Object Lock retention (Compliance mode) */
  objectLockRetainUntilDate?: Date;
  /** S3 user-defined metadata */
  metadata?: Record<string, string>;
  /** SHA-256 base64 checksum for single-PUT integrity */
  checksumSha256?: string;
}

export interface HeadResult {
  contentLength: number;
  checksumSha256?: string;
  /** x-amz-meta-client-sha256 for multipart */
  clientSha256?: string;
  objectLockMode?: string;
  objectLockRetainUntilDate?: Date;
  legalHold?: boolean;
}

export interface StorageBackend {
  readonly name: string;
  /** Single PUT (≤16 MB) with optional SHA-256 checksum */
  putObject(opts: PutOptions): Promise<void>;
  /** Multipart upload (>16 MB, 16 MB parts, 4 concurrent) */
  putObjectMultipart(opts: PutOptions): Promise<void>;
  /** HEAD to verify existence + checksum */
  headObject(bucket: string, key: string): Promise<HeadResult | null>;
  /** Delete an object (used on SHA-256 mismatch retry) */
  deleteObject(bucket: string, key: string): Promise<void>;
  /** Apply or release Object Lock legal hold */
  putLegalHold(bucket: string, key: string, on: boolean): Promise<void>;
  /** Generate a pre-signed GET URL */
  getSignedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  /** Expose the underlying S3Client for SDK-level operations */
  readonly client: S3Client;
}
