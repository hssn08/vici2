/**
 * __tests__/integration/dlq.test.ts
 *
 * 6-attempt exhaustion → DLQ; transcript_status='failed'.
 * N07 PLAN §12.3 / AC-13.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleTranscriptionFailure, NoopAuditWriter } from '../../src/jobs/transcription-job.js';

describe('handleTranscriptionFailure — DLQ', () => {
  it('sets transcript_status=failed and moves to DLQ', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const dlqAdd = vi.fn().mockResolvedValue({ id: 'dlq-1' });
    const audit = new NoopAuditWriter();

    const job = {
      id: 'job-99',
      attemptsMade: 6,
      opts: { attempts: 6 },
      data: {
        recordingLogId: '42',
        callUuid: 'fail-uuid',
        tenantId: '1',
        storageUrl: 's3://bucket/key.wav',
        consentStatus: 'not_required',
        durationSec: 120,
      },
    };

    const err = new Error('python sidecar unreachable');

    await handleTranscriptionFailure(
      job as Parameters<typeof handleTranscriptionFailure>[0],
      err,
      { $queryRaw: vi.fn(), $executeRaw: executeRaw } as Parameters<typeof handleTranscriptionFailure>[2],
      audit,
      { add: dlqAdd } as Parameters<typeof handleTranscriptionFailure>[4],
      {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as unknown as Parameters<typeof handleTranscriptionFailure>[5],
    );

    // transcript_status='failed' set
    const updateCalls = executeRaw.mock.calls as unknown[][];
    const failedCall = updateCalls.find((args) => {
      const parts = args[0];
      return Array.isArray(parts) && (parts as string[]).join('').includes('failed');
    });
    expect(failedCall).toBeDefined();

    // DLQ add called
    expect(dlqAdd).toHaveBeenCalledOnce();
    expect(dlqAdd).toHaveBeenCalledWith('dlq', job.data, { removeOnFail: false });
  });
});
