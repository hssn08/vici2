// N01 — WS broadcast test.
// Verifies that notify() publishes the correct payload to the WS channel.

import { describe, it, expect, vi } from "vitest";

vi.mock("prom-client", () => ({
  default: {
    Counter: class MockCounter { inc() {} },
  },
}));

const mockPrisma = {
  notification: {
    create: vi.fn().mockResolvedValue({
      id: BigInt(1),
      tenantId: BigInt(1),
      userId: BigInt(42),
      channel: "in_app",
      category: "callback_due",
      subject: "Callback due",
      body: "Details here",
      severity: "warning",
      link: null,
      readAt: null,
      createdAt: new Date("2026-05-13T10:00:00Z"),
    }),
  },
  notificationPref: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue({ email: "agent@example.com" }),
  },
};

const { notify } = await import("../../src/notifications/service.js");

describe("N01 WS broadcast", () => {
  it("publishes notifications.new to correct channel", async () => {
    const redis = { publish: vi.fn().mockResolvedValue(1) };

    await notify(mockPrisma as never, redis, null, {
      tenantId: 1,
      userId: 42,
      category: "callback_due",
      subject: "Callback due",
      body: "Details here",
    });

    expect(redis.publish).toHaveBeenCalledOnce();
    const [channel, rawPayload] = redis.publish.mock.calls[0] as [string, string];
    expect(channel).toBe("t:1:ws:user:42");

    const payload = JSON.parse(rawPayload) as { type: string; notification: { id: string; category: string } };
    expect(payload.type).toBe("notifications.new");
    expect(payload.notification.id).toBe("1");
    expect(payload.notification.category).toBe("callback_due");
  });

  it("does NOT publish WS for email-channel notification", async () => {
    const redis = { publish: vi.fn().mockResolvedValue(1) };
    const emailQueue = { add: vi.fn().mockResolvedValue({}) };

    mockPrisma.notification.create.mockResolvedValueOnce({
      id: BigInt(2),
      tenantId: BigInt(1),
      userId: BigInt(42),
      channel: "email",
      category: "import_complete",
      subject: "Import done",
      body: "Your import finished",
      severity: "info",
      link: null,
      readAt: null,
      createdAt: new Date(),
    });

    await notify(mockPrisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 42,
      category: "import_complete",
      subject: "Import done",
      body: "Your import finished",
      channels: ["email"],
    });

    expect(redis.publish).not.toHaveBeenCalled();
    expect(emailQueue.add).toHaveBeenCalledOnce();
  });
});
