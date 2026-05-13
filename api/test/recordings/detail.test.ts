// R03 — Recording detail route unit tests.
//
// Run: pnpm test (vitest)

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../../src/auth/audit.js", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

import { getPrisma } from "../../src/lib/prisma.js";
import { audit } from "../../src/auth/audit.js";
import { registerRecordingDetailRoute } from "../../src/routes/recordings/detail.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_AUTH = {
  uid: 1,
  tenantId: 2,
  role: "admin" as const,
  perms: new Set(["recording:list", "recording:download"] as const),
  jti: "jti",
  totpVerified: false,
  rawClaims: {} as unknown as Parameters<typeof registerRecordingDetailRoute>[0],
  userGroupId: null,
  allowedCampaigns: "*" as const,
};

const SUPER_AUTH = { ...ADMIN_AUTH, role: "super_admin" as const };

const SUPERVISOR_AUTH = {
  ...ADMIN_AUTH,
  role: "supervisor" as const,
  allowedCampaigns: [42n] as bigint[],
};

const AGENT_AUTH = {
  ...ADMIN_AUTH,
  uid: 7,
  role: "agent" as const,
};

const NO_PERMS_AUTH = {
  ...ADMIN_AUTH,
  perms: new Set<string>(),
};

function makeDetailRow(overrides = {}) {
  return {
    id: 123n,
    call_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    start_time: new Date("2026-05-13T14:00:00Z"),
    duration_sec: 187,
    size_bytes: 3145728n,
    sha256: Buffer.from("abc123", "utf-8"),
    lifecycle_state: "available",
    consent_status: "prompted_accepted",
    failure_reason: null,
    encoded_at: null,
    campaign_id: 42n,
    campaign_name: "Summer Campaign",
    user_id: 7n,
    agent_first_name: "Jane",
    agent_last_name: "Smith",
    lead_id: 55001n,
    lead_phone: "5555551234",
    disposition: "CALLBK",
    transcript_status: "completed",
    transcript_word_count: 423,
    transcript_uri: "s3://bucket/tenants/2/calls/2026/05/13/aaaa.transcript.json",
    legal_hold: 0,
    legal_hold_reason: null,
    storage_url: "s3://bucket/tenants/2/calls/2026/05/13/aaaa.wav",
    ...overrides,
  };
}

type MockPrisma = {
  $queryRaw: ReturnType<typeof vi.fn>;
};

function buildApp() {
  const handlers: Map<string, (req: unknown, reply: unknown) => Promise<unknown>> = new Map();
  const app = {
    get: (path: string, opts: unknown, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
      handlers.set(`GET:${path}`, handler);
    },
    _call: async (path: string, req: unknown, reply: unknown) => {
      const handler = handlers.get(`GET:${path}`);
      if (!handler) throw new Error(`No handler for GET:${path}`);
      return handler(req, reply);
    },
    requireAuth: vi.fn(),
  };
  return { app };
}

function buildRequest(id: string, authOverride?: unknown) {
  return {
    params: { id },
    ip: "127.0.0.1",
    headers: { "user-agent": "vitest" },
    id: "req-2",
    auth: authOverride ?? ADMIN_AUTH,
  };
}

function buildReply() {
  const reply = {
    _code: 200,
    _body: null as unknown,
    code: vi.fn().mockImplementation(function (this: typeof reply, c: number) { this._code = c; return this; }),
    send: vi.fn().mockImplementation(function (this: typeof reply, b: unknown) { this._body = b; return this; }),
  };
  return reply;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/recordings/:id/detail — detail route", () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = { $queryRaw: vi.fn() };
    vi.mocked(getPrisma).mockReturnValue(mockPrisma as unknown as ReturnType<typeof getPrisma>);
  });

  it("returns 401 when auth is missing", async () => {
    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = { ...buildRequest("123"), auth: undefined };
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("returns 403 when role lacks recording:list", async () => {
    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", NO_PERMS_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("returns 404 when row not found (tenant isolation)", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("999", ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("returns full detail for admin with unmasked phone", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeDetailRow()]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);

    const body = reply._body as Record<string, unknown>;
    expect(body.id).toBe("123");
    expect(body.call_uuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(body.lead_phone).toBe("5555551234"); // unmasked for admin
    expect(body.agent_name).toBe("Jane Smith");
    expect(body.can_integrity_verify).toBe(true);
    expect(body.can_legal_hold).toBe(false); // admin, not super_admin
  });

  it("sets can_legal_hold=true for super_admin", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeDetailRow()]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", SUPER_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);

    const body = reply._body as Record<string, unknown>;
    expect(body.can_legal_hold).toBe(true);
  });

  it("masks phone for supervisor", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeDetailRow()]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", SUPERVISOR_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);

    const body = reply._body as Record<string, unknown>;
    expect(body.lead_phone).toBe("***-***-1234");
    expect(body.can_integrity_verify).toBe(false); // supervisor cannot
    expect(body.can_legal_hold).toBe(false);
  });

  it("returns 404 for agent accessing other user's recording", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      makeDetailRow({ user_id: 99n }), // different user than AGENT_AUTH.uid=7
    ]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", AGENT_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);
    expect(reply.code).toHaveBeenCalledWith(404); // 404 not 403 to avoid enumeration
  });

  it("returns 404 for supervisor accessing out-of-scope campaign", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      makeDetailRow({ campaign_id: 99n }), // not in SUPERVISOR_AUTH.allowedCampaigns=[42n]
    ]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", SUPERVISOR_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("writes audit row with recording.accessed action", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeDetailRow()]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recording.accessed",
        entityId: "123",
        tenantId: ADMIN_AUTH.tenantId,
        ip: "127.0.0.1",
      }),
    );
  });

  it("exposes storage_url_prefix without full key", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([makeDetailRow()]);

    const { app } = buildApp();
    await registerRecordingDetailRoute(app);

    const req = buildRequest("123", ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings/:id/detail", req, reply);

    const body = reply._body as Record<string, unknown>;
    expect(body.storage_url_prefix).toBe("s3://bucket/tenants/2/calls/2026/05/13/");
    // Full S3 key (aaaa.wav) should not be in the prefix
    expect(String(body.storage_url_prefix)).not.toContain("aaaa.wav");
  });
});
