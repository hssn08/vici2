// N01 — Email queue enqueue tests.
// Tests: enqueue on email channel, no enqueue when user.email is null,
//        no enqueue when emailQueue is null.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("prom-client", () => ({
  default: {
    Counter: class MockCounter { inc() {} },
  },
}));

const { notify } = await import("../../src/notifications/service.js");

function makePrisma(emailOverride?: string | null) {
  return {
    notification: {
      create: vi.fn().mockResolvedValue({
        id: BigInt(1),
        tenantId: BigInt(1),
        userId: BigInt(10),
        channel: "email",
        category: "import_failed",
        subject: "Import failed",
        body: "Your import failed due to an error",
        severity: "error",
        link: null,
        readAt: null,
        createdAt: new Date(),
      }),
    },
    notificationPref: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(
        emailOverride !== undefined ? { email: emailOverride } : { email: "user@example.com" },
      ),
    },
  };
}

describe("N01 email queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues email job with correct fields", async () => {
    const prisma = makePrisma();
    const redis = { publish: vi.fn() };
    const emailQueue = { add: vi.fn().mockResolvedValue({ id: "j1" }) };

    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 10,
      category: "import_failed",
      subject: "Import failed",
      body: "Your import failed",
      channels: ["email"],
    });

    expect(emailQueue.add).toHaveBeenCalledOnce();
    const [, jobData, opts] = emailQueue.add.mock.calls[0] as [string, { to: string; subject: string; body: string }, { attempts: number }];
    expect(jobData.to).toBe("user@example.com");
    expect(jobData.subject).toBe("Import failed");
    expect(jobData.body).toBe("Your import failed");
    expect(opts.attempts).toBe(3);
  });

  it("does not enqueue when user.email is null", async () => {
    const prisma = makePrisma(null);
    const redis = { publish: vi.fn() };
    const emailQueue = { add: vi.fn() };

    await notify(prisma as never, redis, emailQueue, {
      tenantId: 1,
      userId: 10,
      category: "import_failed",
      subject: "Import failed",
      body: "Your import failed",
      channels: ["email"],
    });

    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it("does not enqueue when emailQueue is null (SMTP not configured)", async () => {
    const prisma = makePrisma();
    const redis = { publish: vi.fn() };

    // Pass null email queue — SMTP not configured
    await notify(prisma as never, redis, null, {
      tenantId: 1,
      userId: 10,
      category: "import_failed",
      subject: "Import failed",
      body: "Your import failed",
      channels: ["email"],
    });

    // No crash, no email sent
    expect(prisma.notification.create).toHaveBeenCalledOnce();
  });
});
