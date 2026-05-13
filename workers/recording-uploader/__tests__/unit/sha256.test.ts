/**
 * Unit tests: SHA-256 streaming correctness.
 * R02 PLAN §17.1.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { streamSha256 } from '../../src/jobs/recording-upload.js';

describe('streamSha256', () => {
  let tmpDir: string;
  let testFile: string;
  const content = Buffer.from('Hello, WAV world! '.repeat(100));

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r02-test-'));
    testFile = join(tmpDir, 'test.wav');
    writeFileSync(testFile, content);
  });

  after(() => {
    try { unlinkSync(testFile); } catch { /* ignore */ }
  });

  it('produces correct SHA-256 hex for known content', async () => {
    const expected = createHash('sha256').update(content).digest('hex');
    const { hex } = await streamSha256(testFile);
    assert.equal(hex, expected);
  });

  it('produces correct base64 for known content', async () => {
    const expectedHex = createHash('sha256').update(content).digest('hex');
    const expectedBase64 = Buffer.from(expectedHex, 'hex').toString('base64');
    const { base64 } = await streamSha256(testFile);
    assert.equal(base64, expectedBase64);
  });

  it('streaming hash equals one-shot hash', async () => {
    const oneShot = createHash('sha256').update(content).digest('hex');
    const { hex: streaming } = await streamSha256(testFile);
    assert.equal(streaming, oneShot, 'streaming and one-shot SHA-256 must match');
  });

  it('rejects on missing file', async () => {
    await assert.rejects(() => streamSha256('/no/such/file.wav'));
  });
});
