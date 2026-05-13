// S05 — AnnotationService unit tests
// Tests lock enforcement and annotation limits
// S05 PLAN §12.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationService, AnnotationError, MAX_ANNOTATIONS_PER_CALL } from '../../src/services/coaching/annotation-service.js';
import type { PrismaClient } from '@prisma/client';

function makeMockPrisma() {
  return {
    callAnnotation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    callScorecard: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaClient;
}

describe('AnnotationService', () => {
  let db: ReturnType<typeof makeMockPrisma>;
  let service: AnnotationService;

  beforeEach(() => {
    db = makeMockPrisma();
    service = new AnnotationService(db as unknown as PrismaClient);
  });

  it('creates annotation successfully on draft scorecard', async () => {
    (db.callAnnotation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (db.callScorecard.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, status: 'draft',
    });
    const mockAnnotation = { id: 1n, callUuid: 'test-uuid', timestampMs: 5000 };
    (db.callAnnotation.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockAnnotation);

    const result = await service.create({
      tenantId: 1,
      callUuid: 'test-uuid',
      scorecardId: 1n,
      supervisorId: 42,
      timestampMs: 5000,
      text: 'Great empathy',
      tag: 'positive',
    });

    expect(result).toBe(mockAnnotation);
  });

  it('rejects annotation on finalized scorecard', async () => {
    (db.callAnnotation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (db.callScorecard.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, status: 'finalized',
    });

    await expect(service.create({
      tenantId: 1,
      callUuid: 'test-uuid',
      scorecardId: 1n,
      supervisorId: 42,
      timestampMs: 5000,
      text: 'Too late',
      tag: 'needs_improvement',
    })).rejects.toThrow(AnnotationError);
  });

  it('rejects edit on finalized scorecard annotation', async () => {
    (db.callAnnotation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, supervisorId: 42n, scorecardId: 1n,
    });
    (db.callScorecard.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, status: 'finalized',
    });

    await expect(service.update({
      id: 1n,
      tenantId: 1,
      supervisorId: 42,
      text: 'Updated text',
    })).rejects.toThrow(AnnotationError);
  });

  it('allows edit on draft scorecard annotation', async () => {
    (db.callAnnotation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, supervisorId: 42n, scorecardId: 1n,
    });
    (db.callScorecard.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, status: 'draft',
    });
    const mockUpdated = { id: 1n, text: 'Updated text' };
    (db.callAnnotation.update as ReturnType<typeof vi.fn>).mockResolvedValue(mockUpdated);

    const result = await service.update({
      id: 1n,
      tenantId: 1,
      supervisorId: 42,
      text: 'Updated text',
    });
    expect(result).toBe(mockUpdated);
  });

  it('rejects timestampMs > callDurationMs', async () => {
    (db.callAnnotation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    await expect(service.create({
      tenantId: 1,
      callUuid: 'test',
      supervisorId: 42,
      timestampMs: 300000,
      callDurationMs: 60000,
      text: 'Beyond end',
      tag: 'needs_improvement',
    })).rejects.toThrow(AnnotationError);
  });

  it(`rejects creation when count >= ${MAX_ANNOTATIONS_PER_CALL}`, async () => {
    (db.callAnnotation.count as ReturnType<typeof vi.fn>).mockResolvedValue(MAX_ANNOTATIONS_PER_CALL);

    await expect(service.create({
      tenantId: 1,
      callUuid: 'test',
      supervisorId: 42,
      timestampMs: 1000,
      text: 'Over limit',
      tag: 'needs_improvement',
    })).rejects.toThrow(AnnotationError);
  });

  it('rejects edit by non-creating supervisor', async () => {
    (db.callAnnotation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, supervisorId: 99n, scorecardId: null,
    });

    await expect(service.update({
      id: 1n,
      tenantId: 1,
      supervisorId: 42, // different from 99
      text: 'Not mine',
    })).rejects.toThrow(AnnotationError);
  });

  it('returns 404 on missing annotation', async () => {
    (db.callAnnotation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.update({
      id: 999n,
      tenantId: 1,
      supervisorId: 42,
      text: 'Ghost',
    })).rejects.toThrow(AnnotationError);
  });
});
