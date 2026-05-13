/**
 * Integration test: idempotency — HEAD-on-retry skips duplicate PutObject.
 * R02 PLAN §10, §17.2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { StorageBackend, PutOptions, HeadResult } from '../../src/backends/types.js';

// ---------------------------------------------------------------------------
// Counting mock backend
// ---------------------------------------------------------------------------

class CountingBackend implements StorageBackend {
  readonly name = 'counting-mock';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client = {} as any;
  public putCount = 0;
  public headCount = 0;
  private stored: { sha256?: string; clientSha256?: string; contentLength: number } | null = null;

  async putObject(opts: PutOptions): Promise<void> {
    this.putCount++;
    this.stored = {
      sha256: opts.checksumSha256,
      clientSha256: opts.metadata?.['client-sha256'],
      contentLength: opts.contentLength,
    };
  }

  async putObjectMultipart(opts: PutOptions): Promise<void> {
    this.putCount++;
    this.stored = { clientSha256: opts.metadata?.['client-sha256'], contentLength: opts.contentLength };
  }

  async headObject(_bucket: string, _key: string): Promise<HeadResult | null> {
    this.headCount++;
    if (!this.stored) return null;
    return {
      contentLength: this.stored.contentLength,
      checksumSha256: this.stored.sha256,
      clientSha256: this.stored.clientSha256,
    };
  }

  async deleteObject(): Promise<void> { /* no-op */ }
  async putLegalHold(): Promise<void> { /* no-op */ }
  async getSignedUrl(_b: string, k: string, ttl: number): Promise<string> {
    return `https://mock/${k}?ttl=${ttl}`;
  }
}

// ---------------------------------------------------------------------------
// Simulate retry idempotency path
// ---------------------------------------------------------------------------

async function simulateUploadWithRetry(backend: CountingBackend, attemptsMade: number, sha256Hex: string): Promise<'uploaded' | 'skipped'> {
  const bucket = 'test-bucket';
  const key = 'tenants/1/calls/2026/05/13/test.wav';

  if (attemptsMade > 0) {
    // HEAD first on retry
    const head = await backend.headObject(bucket, key);
    if (head) {
      const existingClientSha = head.clientSha256 ?? head.checksumSha256;
      if (existingClientSha && existingClientSha === sha256Hex) {
        return 'skipped';
      }
    }
  }

  await backend.putObject({
    bucket,
    key,
    body: Buffer.from('test'),
    contentType: 'audio/wav',
    contentLength: 4,
    checksumSha256: sha256Hex,
    metadata: { 'client-sha256': sha256Hex },
  });
  return 'uploaded';
}

describe('idempotency', () => {
  const testContent = Buffer.from('test WAV content');
  const sha256Hex = createHash('sha256').update(testContent).digest('hex');

  it('first attempt always uploads (no pre-HEAD)', async () => {
    const backend = new CountingBackend();
    const result = await simulateUploadWithRetry(backend, 0, sha256Hex);
    assert.equal(result, 'uploaded');
    assert.equal(backend.putCount, 1);
    assert.equal(backend.headCount, 0, 'no HEAD on first attempt');
  });

  it('retry with matching SHA-256 skips PutObject', async () => {
    const backend = new CountingBackend();
    // First: upload
    await simulateUploadWithRetry(backend, 0, sha256Hex);
    // Second: retry — should HEAD and skip
    const result = await simulateUploadWithRetry(backend, 1, sha256Hex);
    assert.equal(result, 'skipped');
    assert.equal(backend.putCount, 1, 'only 1 PutObject across both attempts');
    assert.equal(backend.headCount, 1, 'HEAD called on retry');
  });

  it('retry with mismatched SHA-256 re-uploads', async () => {
    const backend = new CountingBackend();
    // First upload with different sha (simulate a corrupted prior upload)
    await simulateUploadWithRetry(backend, 0, 'aabbcc');
    // Retry with correct sha
    const result = await simulateUploadWithRetry(backend, 1, sha256Hex);
    assert.equal(result, 'uploaded', 'should re-upload on mismatch');
    assert.equal(backend.putCount, 2);
  });
});
