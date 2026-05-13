/**
 * workers/src/jobs/rnd-scrub/__tests__/result-writer.test.ts
 *
 * N06 — Unit tests for the result writer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeResults } from '../../src/jobs/rnd-scrub/result-writer.js';
import type { RndResultItem } from '../../src/jobs/rnd-scrub/client-types.js';
import type { PhoneWithConsent } from '../../src/jobs/rnd-scrub/batcher.js';

// ---------------------------------------------------------------------------
// Mock PrismaClient
// ---------------------------------------------------------------------------

const mockRndLookupLogCreateMany = vi.fn().mockResolvedValue({ count: 0 });
const mockRndScrubJobUpdate = vi.fn().mockResolvedValue({});
const mockExecuteRawUnsafe = vi.fn().mockResolvedValue(0);
const mockAudit = vi.fn().mockResolvedValue(undefined);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockDb(): any {
  return {
    rndLookupLog: { createMany: mockRndLookupLogCreateMany },
    rndScrubJob: { update: mockRndScrubJobUpdate },
    $executeRawUnsafe: mockExecuteRawUnsafe,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-05-13T20:00:00.000Z';

function makeResultItems(overrides: Partial<RndResultItem>[]): RndResultItem[] {
  return overrides.map((o) => ({
    tn: '+12025551234',
    result: 'no' as const,
    disconnect_date: null,
    queried_at: NOW_ISO,
    ...o,
  }));
}

function makePhones(phones: string[]): PhoneWithConsent[] {
  return phones.map((p) => ({
    phoneE164: p,
    consentDate: new Date('2025-01-01'),
    consentDateSrc: 'pewc' as const,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts lookup log rows for all results', async () => {
    const results = makeResultItems([
      { tn: '+12025551111', result: 'yes', disconnect_date: '2025-01-15' },
      { tn: '+12025552222', result: 'no' },
      { tn: '+12025553333', result: 'no_data' },
    ]);
    const originals = makePhones(['+12025551111', '+12025552222', '+12025553333']);

    await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(mockRndLookupLogCreateMany).toHaveBeenCalledOnce();
    const createData = (mockRndLookupLogCreateMany.mock.calls[0] as [{ data: unknown[] }])[0].data;
    expect(createData).toHaveLength(3);
  });

  it('inserts DNC for yes results (noDataPolicy=safe)', async () => {
    const results = makeResultItems([
      { tn: '+12025551110', result: 'yes', disconnect_date: '2025-01-15' },
      { tn: '+12025552220', result: 'no' },
    ]);
    const originals = makePhones(['+12025551110', '+12025552220']);

    const result = await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(result.yesCount).toBe(1);
    expect(result.noCount).toBe(1);
    expect(result.dncInserted).toBe(1);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledOnce();
    const sql = (mockExecuteRawUnsafe.mock.calls[0] as [string])[0];
    expect(sql).toContain("INSERT IGNORE INTO dnc");
    expect(sql).toContain("reassigned");
  });

  it('does NOT insert DNC for no_data when noDataPolicy=safe', async () => {
    const results = makeResultItems([{ tn: '+12025553339', result: 'no_data' }]);
    const originals = makePhones(['+12025553339']);

    const result = await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(result.noDataCount).toBe(1);
    expect(result.dncInserted).toBe(0);
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('DOES insert DNC for no_data when noDataPolicy=block', async () => {
    const results = makeResultItems([{ tn: '+12025553339', result: 'no_data' }]);
    const originals = makePhones(['+12025553339']);

    const result = await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'block',
      audit: mockAudit,
    });

    expect(result.dncInserted).toBe(1);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledOnce();
  });

  it('emits audit event for each yes result', async () => {
    const results = makeResultItems([
      { tn: '+12025551110', result: 'yes', disconnect_date: '2025-01-15' },
      { tn: '+12025551120', result: 'yes', disconnect_date: '2025-03-01' },
    ]);
    const originals = makePhones(['+12025551110', '+12025551120']);

    await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(mockAudit).toHaveBeenCalledTimes(2);
    const firstCall = mockAudit.mock.calls[0] as [bigint, string, Record<string, unknown>];
    expect(firstCall[1]).toBe('rnd.number.flagged_reassigned');
    // Phone should be masked in audit
    const data = firstCall[2];
    expect(data['phoneE164Masked']).toBe('+1202555****');
  });

  it('updates scrub job counters', async () => {
    const results = makeResultItems([
      { tn: '+12025551110', result: 'yes' },
      { tn: '+12025551120', result: 'no' },
      { tn: '+12025551130', result: 'no_data' },
    ]);
    const originals = makePhones(['+12025551110', '+12025551120', '+12025551130']);

    await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results,
      originals,
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(mockRndScrubJobUpdate).toHaveBeenCalledOnce();
    const updateData = (mockRndScrubJobUpdate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(updateData.phonesQueried).toEqual({ increment: 3 });
    expect(updateData.phonesYes).toEqual({ increment: 1 });
    expect(updateData.phonesNo).toEqual({ increment: 1 });
    expect(updateData.phonesNoData).toEqual({ increment: 1 });
  });

  it('handles empty results gracefully', async () => {
    const result = await writeResults({
      db: makeMockDb(),
      tenantId: 1n,
      scrubJobId: 'SCRUB01',
      campaignId: 'CAMP-001',
      results: [],
      originals: [],
      noDataPolicy: 'safe',
      audit: mockAudit,
    });

    expect(result.yesCount).toBe(0);
    expect(result.noCount).toBe(0);
    expect(mockRndLookupLogCreateMany).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });
});
