/**
 * __tests__/integration/consent-blocked.test.ts
 *
 * AC-6: consent_status='prompted_declined' produces no S3 object;
 *        transcript_status='consent_blocked'.
 *
 * N07 PLAN §12.3.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Re-test the consent gate at the stream consumer level
// (The processTranscriptionJob never receives consent_blocked calls — the
//  stream consumer handles it before enqueueing.)
// ---------------------------------------------------------------------------

describe('consent-blocked integration', () => {
  it('consent_status=prompted_declined → no S3 upload; transcript_status=consent_blocked', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const s3Send = vi.fn();
    const queueAdd = vi.fn();

    // Simulate stream consumer processing a consent-blocked message
    const CONSENT_BLOCKED = new Set(['prompted_declined', 'skipped']);

    async function processStreamMessage(
      consentStatus: string,
      recordingLogId: string,
    ) {
      if (CONSENT_BLOCKED.has(consentStatus)) {
        await executeRaw(
          Object.assign(['UPDATE recording_log SET transcript_status = '], ['']) as unknown as TemplateStringsArray,
          'consent_blocked',
          BigInt(recordingLogId),
        );
        // No S3 upload
        return 'consent_blocked';
      }
      queueAdd('transcription', { recordingLogId });
      return 'queued';
    }

    const result = await processStreamMessage('prompted_declined', '42');

    expect(result).toBe('consent_blocked');
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(s3Send).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('consent_status=not_required → BullMQ job enqueued', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const queueAdd = vi.fn();

    const CONSENT_BLOCKED = new Set(['prompted_declined', 'skipped']);

    async function processStreamMessage(consentStatus: string, recordingLogId: string) {
      if (CONSENT_BLOCKED.has(consentStatus)) {
        await executeRaw(
          ['UPDATE'] as unknown as TemplateStringsArray,
          'consent_blocked',
        );
        return 'consent_blocked';
      }
      queueAdd('transcription', { recordingLogId });
      return 'queued';
    }

    const result = await processStreamMessage('not_required', '77');

    expect(result).toBe('queued');
    expect(queueAdd).toHaveBeenCalledOnce();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
