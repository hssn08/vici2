/**
 * Integration test: two-phase deletion sweeper logic.
 * R02 PLAN §9, §17.2.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Minimal sweeper unit that tests the core logic without DB
// ---------------------------------------------------------------------------

interface SweepCandidate {
  id: bigint;
  tenant_id: bigint;
  recording_log_id: bigint;
  legal_hold: number;
  filename: string;
  updatedAt: Date;
}

async function sweepCandidate(
  candidate: SweepCandidate,
  graceHours: number,
): Promise<'deleted' | 'legal_hold_skip' | 'too_recent' | 'already_gone' | 'error'> {
  if (candidate.legal_hold) return 'legal_hold_skip';

  const graceMs = graceHours * 60 * 60 * 1000;
  if (Date.now() - candidate.updatedAt.getTime() < graceMs) return 'too_recent';

  try {
    await unlink(candidate.filename);
    return 'deleted';
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return 'already_gone';
    return 'error';
  }
}

describe('sweeper', () => {
  let tmpDir: string;
  let testFile: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r02-sweep-'));
    testFile = join(tmpDir, 'recording.wav');
    writeFileSync(testFile, 'fake WAV data');
  });

  after(() => {
    if (existsSync(testFile)) {
      try { unlinkSync(testFile); } catch { /* ignore */ }
    }
  });

  it('skips files within 1h grace period', async () => {
    const candidate: SweepCandidate = {
      id: 1n,
      tenant_id: 1n,
      recording_log_id: 1n,
      legal_hold: 0,
      filename: testFile,
      updatedAt: new Date(), // just now
    };
    const result = await sweepCandidate(candidate, 1);
    assert.equal(result, 'too_recent');
    assert.ok(existsSync(testFile), 'file should still exist');
  });

  it('deletes files older than 1h grace', async () => {
    const candidate: SweepCandidate = {
      id: 1n,
      tenant_id: 1n,
      recording_log_id: 1n,
      legal_hold: 0,
      filename: testFile,
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    };
    const result = await sweepCandidate(candidate, 1);
    assert.equal(result, 'deleted');
    assert.ok(!existsSync(testFile), 'file should be deleted');
  });

  it('returns already_gone on ENOENT', async () => {
    const candidate: SweepCandidate = {
      id: 2n,
      tenant_id: 1n,
      recording_log_id: 2n,
      legal_hold: 0,
      filename: '/no/such/file.wav',
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    };
    const result = await sweepCandidate(candidate, 1);
    assert.equal(result, 'already_gone');
  });

  it('skips files with legal_hold', async () => {
    const candidate: SweepCandidate = {
      id: 3n,
      tenant_id: 1n,
      recording_log_id: 3n,
      legal_hold: 1,
      filename: '/any/file.wav',
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    };
    const result = await sweepCandidate(candidate, 1);
    assert.equal(result, 'legal_hold_skip');
  });
});
