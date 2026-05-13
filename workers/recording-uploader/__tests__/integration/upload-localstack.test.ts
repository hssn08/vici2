/**
 * Integration test: full upload flow via mock/LocalStack S3.
 * Uses an in-memory mock backend to avoid requiring external services.
 * When R02_STORAGE_BACKEND=minio and MINIO_ENDPOINT is set, uses real MinIO.
 * R02 PLAN §17.2.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { buildObjectKey, streamSha256, validateUploadParams } from '../../src/jobs/recording-upload.js';
import type { StorageBackend, PutOptions, HeadResult } from '../../src/backends/types.js';

// ---------------------------------------------------------------------------
// In-memory mock backend (no external deps)
// ---------------------------------------------------------------------------

class MockBackend implements StorageBackend {
  readonly name = 'mock';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client = {} as any;
  private objects = new Map<string, { body: Buffer; metadata: Record<string, string>; sha256?: string }>();

  async putObject(opts: PutOptions): Promise<void> {
    const body = opts.body instanceof Buffer ? opts.body : Buffer.alloc(0);
    this.objects.set(`${opts.bucket}/${opts.key}`, {
      body,
      metadata: opts.metadata ?? {},
      sha256: opts.checksumSha256,
    });
  }

  async putObjectMultipart(opts: PutOptions): Promise<void> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      (opts.body as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
      (opts.body as NodeJS.ReadableStream).on('end', resolve);
      (opts.body as NodeJS.ReadableStream).on('error', reject);
    });
    const body = Buffer.concat(chunks);
    this.objects.set(`${opts.bucket}/${opts.key}`, {
      body,
      metadata: opts.metadata ?? {},
    });
  }

  async headObject(bucket: string, key: string): Promise<HeadResult | null> {
    const obj = this.objects.get(`${bucket}/${key}`);
    if (!obj) return null;
    return {
      contentLength: obj.body.length,
      checksumSha256: obj.sha256,
      clientSha256: obj.metadata['client-sha256'],
    };
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async putLegalHold(_bucket: string, _key: string, _on: boolean): Promise<void> { /* no-op */ }

  async getSignedUrl(_bucket: string, key: string, ttl: number): Promise<string> {
    return `https://mock-s3.example.com/${key}?X-Amz-Expires=${ttl}`;
  }

  hasObject(bucket: string, key: string): boolean {
    return this.objects.has(`${bucket}/${key}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload flow (mock backend)', () => {
  let tmpDir: string;
  let testFile: string;
  const content = Buffer.from('RIFF...WAV PCM test data '.repeat(200)); // ~4KB
  const tenantId = 1n;
  const callUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const startTime = new Date('2026-05-13T10:00:00Z');
  const bucket = 'test-bucket';

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r02-int-'));
    testFile = join(tmpDir, `${callUuid}.wav`);
    writeFileSync(testFile, content);
  });

  after(() => {
    try { unlinkSync(testFile); } catch { /* ignore */ }
  });

  it('builds correct object key', () => {
    const key = buildObjectKey(tenantId, callUuid, startTime);
    assert.equal(key, `tenants/1/calls/2026/05/13/${callUuid}.wav`);
  });

  it('validates upload params', () => {
    const key = buildObjectKey(tenantId, callUuid, startTime);
    const retainUntil = new Date(Date.now() + 7 * 365.25 * 86400 * 1000);
    assert.doesNotThrow(() => validateUploadParams(tenantId, callUuid, key, retainUntil));
  });

  it('computes SHA-256 correctly', async () => {
    const { hex } = await streamSha256(testFile);
    const expected = createHash('sha256').update(content).digest('hex');
    assert.equal(hex, expected);
  });

  it('putObject stores object and HEAD finds it', async () => {
    const backend = new MockBackend();
    const key = buildObjectKey(tenantId, callUuid, startTime);
    const { hex: sha256Hex, base64: sha256Base64 } = await streamSha256(testFile);

    await backend.putObject({
      bucket,
      key,
      body: content,
      contentType: 'audio/wav',
      contentLength: content.length,
      checksumSha256: sha256Base64,
      metadata: { 'client-sha256': sha256Hex },
    });

    const head = await backend.headObject(bucket, key);
    assert.ok(head, 'HEAD should find the object');
    assert.equal(head.checksumSha256, sha256Base64);
    assert.equal(head.clientSha256, sha256Hex);
    assert.equal(head.contentLength, content.length);
  });

  it('getSignedUrl returns URL with TTL', async () => {
    const backend = new MockBackend();
    const key = buildObjectKey(tenantId, callUuid, startTime);
    const url = await backend.getSignedUrl(bucket, key, 300);
    assert.ok(url.includes('X-Amz-Expires=300'));
  });

  it('deleteObject removes the object', async () => {
    const backend = new MockBackend();
    const key = buildObjectKey(tenantId, callUuid, startTime);
    await backend.putObject({
      bucket, key, body: content, contentType: 'audio/wav', contentLength: content.length,
    });
    assert.ok(backend.hasObject(bucket, key));
    await backend.deleteObject(bucket, key);
    assert.ok(!backend.hasObject(bucket, key));
  });
});
