// S05 — FeedbackService unit tests
// Tests acknowledge idempotency and access control
// S05 PLAN §12.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackService, FeedbackError } from '../../src/services/coaching/feedback-service.js';
import type { PrismaClient } from '@prisma/client';

function makeMockPrisma() {
  return {
    agentFeedback: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaClient;
}

describe('FeedbackService', () => {
  let db: ReturnType<typeof makeMockPrisma>;
  let service: FeedbackService;

  beforeEach(() => {
    db = makeMockPrisma();
    service = new FeedbackService(db as unknown as PrismaClient);
  });

  it('creates feedback successfully', async () => {
    const mockFeedback = { id: 1n, agentId: 10n, body: 'Great work!', acknowledgedAt: null };
    (db.agentFeedback.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockFeedback);

    const result = await service.create({
      tenantId: 1,
      agentId: 10,
      supervisorId: 42,
      body: 'Great work!',
    });

    expect(result).toBe(mockFeedback);
  });

  it('acknowledges feedback successfully', async () => {
    const now = new Date();
    (db.agentFeedback.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, agentId: 10n, acknowledgedAt: null,
    });
    (db.agentFeedback.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, agentId: 10n, acknowledgedAt: now,
    });

    const result = await service.acknowledge({
      id: 1n,
      tenantId: 1,
      agentId: 10,
    });

    expect(result.acknowledgedAt).toBe(now);
  });

  it('returns 409 when feedback already acknowledged', async () => {
    (db.agentFeedback.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, agentId: 10n, acknowledgedAt: new Date(),
    });

    await expect(service.acknowledge({
      id: 1n,
      tenantId: 1,
      agentId: 10,
    })).rejects.toThrow(FeedbackError);

    try {
      await service.acknowledge({ id: 1n, tenantId: 1, agentId: 10 });
    } catch (err) {
      expect((err as FeedbackError).statusCode).toBe(409);
    }
  });

  it('returns 403 when agent A tries to acknowledge agent B feedback', async () => {
    (db.agentFeedback.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1n, agentId: 20n, acknowledgedAt: null, // belongs to agent 20
    });

    await expect(service.acknowledge({
      id: 1n,
      tenantId: 1,
      agentId: 10, // agent 10 trying to ack agent 20's feedback
    })).rejects.toThrow(FeedbackError);

    try {
      await service.acknowledge({ id: 1n, tenantId: 1, agentId: 10 });
    } catch (err) {
      expect((err as FeedbackError).statusCode).toBe(403);
    }
  });

  it('returns 404 when feedback not found', async () => {
    (db.agentFeedback.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.acknowledge({
      id: 999n,
      tenantId: 1,
      agentId: 10,
    })).rejects.toThrow(FeedbackError);

    try {
      await service.acknowledge({ id: 999n, tenantId: 1, agentId: 10 });
    } catch (err) {
      expect((err as FeedbackError).statusCode).toBe(404);
    }
  });

  it('lists feedback for an agent', async () => {
    const mockList = [{ id: 1n }, { id: 2n }];
    (db.agentFeedback.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(mockList);

    const result = await service.listForAgent({ tenantId: 1, agentId: 10 });
    expect(result).toBe(mockList);
  });
});
