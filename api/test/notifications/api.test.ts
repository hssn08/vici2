// N01 — API endpoint unit tests.
// Tests handlers for list, read, read-all, dismiss using mock Prisma.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("prom-client", () => ({
  default: {
    Counter: class MockCounter { inc() {} },
  },
}));

// Mock getPrisma so handlers use our mock
const mockPrisma = {
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  notificationPref: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};

vi.mock("../../src/lib/prisma.js", () => ({
  getPrisma: () => mockPrisma,
}));

import { handleListNotifications } from "../../src/notifications/handlers/list.js";
import { handleMarkRead } from "../../src/notifications/handlers/read.js";
import { handleReadAll } from "../../src/notifications/handlers/read-all.js";
import { handleDismiss } from "../../src/notifications/handlers/dismiss.js";
import type { AuthContext } from "../../src/auth/middleware.js";

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      uid: 10,
      tenantId: 1,
      role: "agent",
      perms: new Set(),
      jti: "test",
      totpVerified: true,
      rawClaims: {},
    } as AuthContext,
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

function makeReply() {
  const sent: unknown[] = [];
  let statusCode = 200;
  const reply = {
    _sent: sent,
    _code: () => statusCode,
    code: vi.fn((c: number) => { statusCode = c; return reply; }),
    send: vi.fn((body: unknown) => { sent.push(body); return Promise.resolve(); }),
  };
  return reply;
}

const SAMPLE_NOTIF = {
  id: BigInt(1),
  channel: "in_app",
  category: "callback_due",
  subject: "Callback due",
  body: "A callback is due",
  severity: "warning",
  link: null,
  readAt: null,
  createdAt: new Date("2026-05-13T10:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/notifications", () => {
  it("returns items and unreadCount", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([SAMPLE_NOTIF]);
    mockPrisma.notification.count.mockResolvedValue(1);

    const req = makeReq();
    const reply = makeReply();

    await handleListNotifications(req as never, reply as never);

    expect(reply.send).toHaveBeenCalledOnce();
    const body = reply._sent[0] as { items: unknown[]; unreadCount: number };
    expect(body.items).toHaveLength(1);
    expect(body.unreadCount).toBe(1);
  });

  it("returns 401 when no auth", async () => {
    const req = makeReq({ auth: undefined });
    const reply = makeReply();

    await handleListNotifications(req as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("applies cursor pagination", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.count.mockResolvedValue(0);

    const req = makeReq({ query: { cursor: "100", limit: "5" } });
    const reply = makeReply();

    await handleListNotifications(req as never, reply as never);

    const whereArg = mockPrisma.notification.findMany.mock.calls[0][0];
    expect(whereArg.where.id).toEqual({ lt: BigInt("100") });
    expect(whereArg.take).toBe(6); // limit + 1
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  it("marks notification as read", async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({ id: BigInt(1), readAt: null });
    mockPrisma.notification.update.mockResolvedValue({});

    const req = makeReq({ params: { id: "1" } });
    const reply = makeReply();

    await handleMarkRead(req as never, reply as never);

    expect(mockPrisma.notification.update).toHaveBeenCalledOnce();
    expect(reply.send).toHaveBeenCalledWith({ ok: true });
  });

  it("returns 404 for unknown notification", async () => {
    mockPrisma.notification.findFirst.mockResolvedValue(null);

    const req = makeReq({ params: { id: "999" } });
    const reply = makeReply();

    await handleMarkRead(req as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("skips update if already read", async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({
      id: BigInt(1),
      readAt: new Date(),
    });

    const req = makeReq({ params: { id: "1" } });
    const reply = makeReply();

    await handleMarkRead(req as never, reply as never);

    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({ ok: true });
  });
});

describe("POST /api/notifications/read-all", () => {
  it("bulk marks all unread and returns count", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });

    const req = makeReq();
    const reply = makeReply();

    await handleReadAll(req as never, reply as never);

    expect(mockPrisma.notification.updateMany).toHaveBeenCalledOnce();
    expect(reply.send).toHaveBeenCalledWith({ marked: 5 });
  });
});

describe("DELETE /api/notifications/:id", () => {
  it("deletes the notification and returns 204", async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({ id: BigInt(1) });
    mockPrisma.notification.delete.mockResolvedValue({});

    const req = makeReq({ params: { id: "1" } });
    const reply = makeReply();

    await handleDismiss(req as never, reply as never);

    expect(mockPrisma.notification.delete).toHaveBeenCalledOnce();
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it("returns 404 when notification not found", async () => {
    mockPrisma.notification.findFirst.mockResolvedValue(null);

    const req = makeReq({ params: { id: "999" } });
    const reply = makeReply();

    await handleDismiss(req as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("returns 400 for invalid id", async () => {
    const req = makeReq({ params: { id: "not-a-number" } });
    const reply = makeReply();

    await handleDismiss(req as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(400);
  });
});
