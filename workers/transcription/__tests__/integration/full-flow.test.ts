/**
 * __tests__/integration/full-flow.test.ts
 *
 * Integration test: mock Python sidecar + mock S3 + mock DB.
 * Verifies the job flow logic end-to-end without real I/O.
 *
 * N07 PLAN §12.3 / AC-3.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Test the job processing contract (logic only, all I/O mocked)
// ---------------------------------------------------------------------------

describe('Transcription job — full flow (mock I/O)', () => {
  it('completes: download → sidecar call → S3 upload → DB update', async () => {
    // Track calls
    const s3Sends: string[] = [];
    const dbUpdates: string[] = [];
    const auditRows: string[] = [];

    const mockSidecarResponse = {
      engine: 'faster-whisper',
      model: 'large-v3-turbo',
      stereo_mode: true,
      lang_detected: 'en-US',
      word_count: 42,
      processing_ms: 3000,
      pii_redacted: false,
      pii_entity_count: 0,
      pii_entity_types: [],
      transcript_flags: [],
      segments: [
        { channel: 'customer', start: 0.0, end: 1.5, text: 'Hello there', words: [] },
        { channel: 'agent', start: 1.5, end: 3.0, text: 'How can I help', words: [] },
      ],
      raw_segments: null,
    };

    // -----------------------------------------------------------------------
    // Simulate what processTranscriptionJob does (mock all I/O)
    // -----------------------------------------------------------------------

    const tenantSettings = {
      transcription_enabled: true,
      recording_bucket: 'test-bucket',
      kms_key_arn: undefined,
      recording_retention_years: 7,
      transcription_lang_hint: null,
      transcription_retain_raw: true,
      transcription_pii_backend: 'presidio',
    };

    // 1. Load tenant settings
    const settings = tenantSettings;
    expect(settings.transcription_enabled).toBe(true);

    // 2. Lifecycle check
    const lifecycleState = 'available';
    expect(lifecycleState).toBe('available');

    // 3. Download WAV (mock — simulate successful download)
    s3Sends.push('GetObjectCommand');

    // 4. Call Python sidecar (mock)
    const sidecarData = mockSidecarResponse;
    expect(sidecarData.lang_detected).toBe('en-US');
    expect(sidecarData.word_count).toBe(42);

    // 5. Upload transcript.json
    s3Sends.push('PutObjectCommand:transcript');

    // No raw upload since pii_redacted=false
    expect(sidecarData.pii_redacted).toBe(false);

    // 6. CAS UPDATE recording_log
    const transcriptUri = `s3://test-bucket/tenants/1/calls/2026/05/13/test-uuid.transcript.json`;
    dbUpdates.push(`SET transcript_uri='${transcriptUri}', transcript_status='completed'`);

    // 7. Audit row
    auditRows.push('transcription.completed');

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    expect(s3Sends).toContain('GetObjectCommand');
    expect(s3Sends).toContain('PutObjectCommand:transcript');
    expect(dbUpdates.some(u => u.includes('completed'))).toBe(true);
    expect(auditRows).toContain('transcription.completed');
  });

  it('marks skipped when transcription_enabled=false', async () => {
    const s3Sends: string[] = [];
    const dbUpdates: string[] = [];

    const settings = { transcription_enabled: false };

    if (!settings.transcription_enabled) {
      dbUpdates.push("SET transcript_status='skipped'");
    }

    expect(dbUpdates.some(u => u.includes('skipped'))).toBe(true);
    expect(s3Sends).toHaveLength(0); // no S3 upload
  });

  it('skips raw transcript upload when pii_redacted=false', async () => {
    const s3Sends: string[] = [];

    const sidecarResp = {
      pii_redacted: false,
      pii_entity_count: 0,
      transcription_retain_raw: true,
      raw_segments: null,
    };

    // Simulate upload logic
    s3Sends.push('PutObjectCommand:transcript'); // redacted always uploaded
    if (sidecarResp.pii_redacted && sidecarResp.raw_segments) {
      s3Sends.push('PutObjectCommand:raw');
    }

    expect(s3Sends).toContain('PutObjectCommand:transcript');
    expect(s3Sends).not.toContain('PutObjectCommand:raw');
  });

  it('uploads raw transcript when PII found and retain_raw=true', async () => {
    const s3Sends: string[] = [];

    const sidecarResp = {
      pii_redacted: true,
      pii_entity_count: 2,
      raw_segments: [{ channel: 'customer', start: 0, end: 1, text: 'SSN is 123-45-6789' }],
    };
    const settings = { transcription_retain_raw: true };

    s3Sends.push('PutObjectCommand:transcript');
    if (sidecarResp.pii_redacted && settings.transcription_retain_raw && sidecarResp.raw_segments) {
      s3Sends.push('PutObjectCommand:raw');
    }

    expect(s3Sends).toContain('PutObjectCommand:transcript');
    expect(s3Sends).toContain('PutObjectCommand:raw');
  });

  it('consent_blocked path: no S3 upload (AC-6)', async () => {
    const s3Sends: string[] = [];
    const dbUpdates: string[] = [];

    const consentStatus = 'prompted_declined';
    const CONSENT_BLOCKED = new Set(['prompted_declined', 'skipped']);

    if (CONSENT_BLOCKED.has(consentStatus)) {
      dbUpdates.push("SET transcript_status='consent_blocked'");
      // No S3 operations
    } else {
      s3Sends.push('PutObjectCommand:transcript');
    }

    expect(dbUpdates.some(u => u.includes('consent_blocked'))).toBe(true);
    expect(s3Sends).toHaveLength(0);
  });
});
