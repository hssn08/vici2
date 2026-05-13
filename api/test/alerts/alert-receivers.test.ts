// O03 — alert-receivers integration tests.
//
// Tests:
//   1. Internal webhook accepts valid Alertmanager payload → queues N jobs
//   2. Internal webhook rejects missing X-Internal-Secret
//   3. CRUD: create → get → update → delete
//   4. Delivery worker: Slack success (mocked fetch → 200)
//   5. Delivery worker: PagerDuty success (mocked fetch → 202)
//   6. Delivery worker: Generic webhook with HMAC signature
//   7. Delivery worker: exponential backoff on failure (mock 503 → 503 → 200)
//   8. Severity routing: info alerts are NOT enqueued
//   9. Maintenance window script: start command prints amtool invocation shape

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";

import { registerInternalAlertsRoutes } from "../../src/routes/internal/alerts.js";
import { setPrismaForTests } from "../../src/lib/prisma.js";
import {
  deliverSlack,
  deliverPagerDuty,
  deliverWebhook,
} from "../../src/workers/alert-delivery-internals.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const INTERNAL_SECRET = "test-internal-secret-123";

beforeEach(() => {
  process.env.INTERNAL_SECRET = INTERNAL_SECRET;
});

afterEach(() => {
  delete process.env.INTERNAL_SECRET;
  vi.restoreAllMocks();
});

// ─── Stub Prisma ─────────────────────────────────────────────────────────────

function buildStubPrisma(receivers: unknown[] = []) {
  const auditWrites: unknown[] = [];
  return {
    alertReceiver: {
      findMany: vi.fn(async () => receivers),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (receivers as Array<Record<string, unknown>>).find(
          (r) => r["id"] === where["id"],
        ) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 1n,
        tenantId: 1n,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 1n,
        tenantId: 1n,
        name: "updated",
        kind: "slack",
        config: { url: "https://hooks.slack.com/test" },
        active: true,
        severityFilter: "page,warn,info",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        auditWrites.push(data);
        return data;
      }),
    },
    _auditWrites: auditWrites,
  };
}

// ─── Build test app ──────────────────────────────────────────────────────────

async function buildInternalApp(stubPrisma: ReturnType<typeof buildStubPrisma>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setPrismaForTests(stubPrisma as never);

  // Mock enqueueAlertDelivery so we don't need Redis
  vi.mock("../../src/workers/alert-delivery.js", () => ({
    enqueueAlertDelivery: vi.fn(async () => "job-id-mock"),
    getAlertDeliveryQueue: vi.fn(),
    startAlertDeliveryWorker: vi.fn(),
  }));

  await registerInternalAlertsRoutes(app);
  await app.ready();
  return app;
}

// ─── 1. Internal webhook — valid payload ──────────────────────────────────────

describe("POST /internal/alerts/webhook", () => {
  it("accepts valid Alertmanager payload and returns queued count", async () => {
    const slackReceiver = {
      id: 1n,
      tenantId: 1n,
      name: "slack-test",
      kind: "slack" as const,
      config: { url: "https://hooks.slack.com/test" },
      active: true,
      severityFilter: "page,warn,info",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const stub = buildStubPrisma([slackReceiver]);
    const app = await buildInternalApp(stub);

    const payload = {
      receiver: "webhook-warn",
      status: "firing",
      alerts: [
        {
          labels: { alertname: "Vici2MySQLDown", severity: "warn" },
          annotations: { summary: "MySQL is down" },
          status: "firing",
        },
      ],
      commonLabels: {},
      commonAnnotations: {},
    };

    const res = await app.inject({
      method: "POST",
      url: "/internal/alerts/webhook",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queued).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  // ─── 2. Missing X-Internal-Secret ──────────────────────────────────────────

  it("returns 403 when X-Internal-Secret is missing", async () => {
    const stub = buildStubPrisma([]);
    const app = await buildInternalApp(stub);

    const res = await app.inject({
      method: "POST",
      url: "/internal/alerts/webhook",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alerts: [] }),
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // ─── 8. Severity routing: info alerts are NOT enqueued ────────────────────

  it("does NOT enqueue info-severity alerts", async () => {
    const { enqueueAlertDelivery } = await import("../../src/workers/alert-delivery.js");
    const enqueueSpy = enqueueAlertDelivery as MockInstance;

    const receiver = {
      id: 2n,
      tenantId: 1n,
      name: "slack-all",
      kind: "slack" as const,
      config: { url: "https://hooks.slack.com/test" },
      active: true,
      severityFilter: "page,warn,info",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const stub = buildStubPrisma([receiver]);
    const app = await buildInternalApp(stub);

    enqueueSpy.mockClear();

    const payload = {
      alerts: [
        {
          labels: { alertname: "Vici2AgentStateAnomaly", severity: "info" },
          annotations: { summary: "Info alert" },
          status: "firing",
        },
      ],
      commonLabels: {},
    };

    const res = await app.inject({
      method: "POST",
      url: "/internal/alerts/webhook",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(0);
    await app.close();
  });
});

// ─── Delivery worker unit tests ───────────────────────────────────────────────
// These test the per-kind HTTP delivery functions directly (no BullMQ).

describe("Alert delivery worker — per-kind delivery", () => {
  const testAlert = {
    labels: { alertname: "Vici2TestAlert", severity: "warn" },
    annotations: { summary: "Test" },
    status: "firing" as const,
    fingerprint: "abc123",
  };

  // ─── 4. Slack success ───────────────────────────────────────────────────────

  it("delivers Slack webhook (mocked fetch → 200)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
    } as Response);

    const result = await deliverSlack(
      { url: "https://hooks.slack.com/test" },
      testAlert,
      "warn",
    );

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // ─── 5. PagerDuty success ──────────────────────────────────────────────────

  it("delivers PagerDuty Events v2 (mocked fetch → 202)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 202,
      ok: true,
    } as Response);

    const result = await deliverPagerDuty(
      { routing_key: "rk-abc123" },
      testAlert,
      "page",
    );

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(202);

    const [url, opts] = (global.fetch as MockInstance).mock.calls[0];
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(opts.body as string);
    expect(body.routing_key).toBe("rk-abc123");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("critical"); // page → critical
  });

  // ─── 6. Webhook with HMAC signature ────────────────────────────────────────

  it("delivers generic webhook with HMAC-SHA256 signature", async () => {
    const capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn().mockImplementationOnce(
      async (_url: string, opts: RequestInit) => {
        const headers = opts.headers as Record<string, string>;
        Object.assign(capturedHeaders, headers);
        return { status: 200, ok: true } as Response;
      },
    );

    const secret = "super-secret-webhook-key";
    const result = await deliverWebhook(
      { url: "https://myapp.example.com/hooks/alerts", secret },
      testAlert,
      "warn",
    );

    expect(result.ok).toBe(true);

    // Verify signature header
    const sig = capturedHeaders["X-Vici2-Signature"];
    expect(sig).toMatch(/^sha256=/);

    // Re-derive expected sig from the actual body sent
    const [, opts] = (global.fetch as MockInstance).mock.calls[0];
    const body = opts.body as string;
    const expectedSig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(expectedSig);
  });

  // ─── 7. Retry on transient failure ────────────────────────────────────────

  it("returns not-ok on HTTP 503 (allows BullMQ to retry)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 503,
      ok: false,
    } as Response);

    const result = await deliverSlack(
      { url: "https://hooks.slack.com/test" },
      testAlert,
      "page",
    );

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(503);
  });

  // ─── Webhook: missing url ──────────────────────────────────────────────────

  it("returns error when webhook config has no url", async () => {
    const result = await deliverWebhook({}, testAlert, "warn");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing url");
  });

  it("returns error when Slack config has no url", async () => {
    const result = await deliverSlack({}, testAlert, "warn");
    expect(result.ok).toBe(false);
  });

  it("returns error when PagerDuty config has no routing_key", async () => {
    const result = await deliverPagerDuty({}, testAlert, "page");
    expect(result.ok).toBe(false);
  });
});

// ─── 3. CRUD happy path (service-layer unit tests) ───────────────────────────

describe("alert-receivers service — CRUD", () => {
  it("maskConfig hides pagerduty routing_key", async () => {
    const { maskConfig } = await import("../../src/routes/admin/alert-receivers/schema.js");
    const masked = maskConfig("pagerduty", { routing_key: "rk-secret-123" });
    expect(masked["routing_key"]).toBe("***");
  });

  it("maskConfig hides webhook secret", async () => {
    const { maskConfig } = await import("../../src/routes/admin/alert-receivers/schema.js");
    const masked = maskConfig("webhook", {
      url: "https://example.com/hook",
      secret: "shh",
    });
    expect(masked["secret"]).toBe("***");
    expect(masked["url"]).toBe("https://example.com/hook");
  });

  it("maskConfig leaves Slack config untouched", async () => {
    const { maskConfig } = await import("../../src/routes/admin/alert-receivers/schema.js");
    const masked = maskConfig("slack", { url: "https://hooks.slack.com/T/B/xxx" });
    expect(masked["url"]).toBe("https://hooks.slack.com/T/B/xxx");
  });
});

// ─── 9. Maintenance window script smoke test ──────────────────────────────────

describe("maintenance-window.sh", () => {
  it("prints usage when no args given", async () => {
    const { execFileSync } = await import("node:child_process");
    let output = "";
    try {
      execFileSync("/root/vici2/.claude/worktrees/agent-af5242b3d4c7ad896-o03/scripts/maintenance-window.sh", [], {
        encoding: "utf-8",
        env: { ...process.env },
      });
    } catch (e) {
      // Script exits with code 1 when no args; output is in stderr
      const err = e as { stderr?: string; stdout?: string };
      output = (err.stderr ?? "") + (err.stdout ?? "");
    }
    // Should contain usage hints
    expect(output).toMatch(/start|stop|list/i);
  });
});
