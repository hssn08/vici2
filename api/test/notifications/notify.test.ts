// N01 — notify() helper unit tests.
// Tests: channel resolution, in-app DB insert + WS push, email queue enqueue,
//        missing email handling, pref override.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NotifChannel } from "../../src/notifications/categories.js";

// Mock prom-client to avoid metric registration errors in tests
vi.mock("prom-client", () => ({
  default: {
    Counter: class MockCounter {
      inc() {}
    },
  },
}));

// Helpers to build mocks
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    notification: {
      create: vi.fn().mockResolvedValue({
        id: BigInt(1),
        tenantId: BigInt(1),
        userId: BigInt(42),
        channel: "in_app",
        category: "callback_due",
        subject: "Test subject",
        body: "Test body",
        severity: "warning",
        link: null,
        readAt: null,
        createdAt: new Date("2026-05-13T10:00:00Z"),
      }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    notificationPref: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: "agent@example.com" }),
    },
    ...overrides,
  };
}

function makeRedis() {
  return {
    publish: vi.fn().mockResolvedValue(1),
  };
}

function makeEmailQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: "job-1" }),
  };
}

// Dynamic import after mocks
const { notify, resolveChannels } = await import("../../src/notifications/service.js");

describe("N01 resolveChannels", () => {
  it("returns category defaults when no pref and no override", async () => {
    const prisma = makePrisma();
    const channels = await resolveChannels(prisma as never, 42, 1, "callback_due");
    expect(channels).toEqual(["in_app"]);
  });

  it("returns category defaults for import_complete (in_app + email)", async () => {
    const prisma = makePrisma();
    const channels = await resolveChannels(prisma as never, 42, 1, "import_complete");
    expect(channels).toEqual(["in_app", "email"]);
  });

  it("returns user pref override when present", async () => {
    const prisma = makePrisma({
      notificationPref: {
        findUnique: vi.fn().mockResolvedValue({ channels: ["in_app"] }),
        upsert: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const channels = await resolveChannels(prisma as never, 42, 1, "import_complete");
    // User opted out of email — only in_app
    expect(channels).toEqual(["in_app"]);
  });

  it("uses channels override param over DB pref", async () => {
    const prisma = makePrisma();
    const override: NotifChannel[] = ["email"];
    const channels = await resolveChannels(prisma as never, 42, 1, "callback_due", override);
    expect(channels).toEqual(["email"]);
  });
});

describe("N01 notify() — in_app channel", () => {
  it("inserts DB row and publishes WS event", async () => {
    const prisma = makePrisma();
    const redis = makeRedis();

    await notify(prisma as never, redis, null, {
      tenantId: 1,
      userId: 42,
      category: "callback_due",
      subject: "Callback due",
      body: "A callback is due",
    });

    expect(prisma.notification.create).toHaveBeenCalledOnce();
    const createCall = prisma.notification.create.mock.calls[0][0];
    expect(createCall.data.channel).toBe("in_app");
    expect(createCall.data.category).toBe("callback_due");

    expect(redis.publish).toHaveBeenCalledOnce();
    const publishCall = redis.publish.mock.calls[0];
    expect(publishCall[0]).toBe("t:1:ws:user:42");
    const payload = JSON.parse(publishCall[1] as string) as { type: string };
    expect(payload.type).toBe("notifications.new");
  });

  it("does NOT enqueue BullMQ job for in_app-only category", async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    const emailQueue = makeEmailQueue();

    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 42,
      category: "callback_due",
      subject: "Callback due",
      body: "A callback is due",
    });

    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});

describe("N01 notify() — email channel", () => {
  it("inserts DB row and enqueues BullMQ job", async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    const emailQueue = makeEmailQueue();

    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 42,
      category: "import_complete",
      subject: "Import finished",
      body: "Your import has completed",
    });

    // Two channels: in_app + email → two DB rows
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    // BullMQ job for email
    expect(emailQueue.add).toHaveBeenCalledOnce();
    const jobCall = emailQueue.add.mock.calls[0];
    expect(jobCall[1].to).toBe("agent@example.com");
    expect(jobCall[1].subject).toBe("Import finished");
  });

  it("skips email enqueue when user.email is null", async () => {
    const prisma = makePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue({ email: null }),
      },
    });
    const redis = makeRedis();
    const emailQueue = makeEmailQueue();

    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 42,
      category: "import_complete",
      subject: "Import finished",
      body: "Your import has completed",
    });

    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});

describe("N01 notify() — channels override", () => {
  it("uses explicit channels param to override defaults", async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    const emailQueue = makeEmailQueue();

    // Force email-only for callback_due (which defaults to in_app only)
    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 42,
      category: "callback_due",
      subject: "Callback due",
      body: "A callback is due",
      channels: ["email"],
    });

    expect(prisma.notification.create).toHaveBeenCalledOnce();
    const createCall = prisma.notification.create.mock.calls[0][0];
    expect(createCall.data.channel).toBe("email");
    expect(redis.publish).not.toHaveBeenCalled();
    expect(emailQueue.add).toHaveBeenCalledOnce();
  });
});
