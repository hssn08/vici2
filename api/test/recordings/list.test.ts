// R03 — Recordings list route unit tests.
//
// Run: pnpm test (vitest)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock dependencies BEFORE importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/prisma.js", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../../src/auth/audit.js", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

import { getPrisma } from "../../src/lib/prisma.js";
import { audit } from "../../src/auth/audit.js";
import { registerRecordingListRoute } from "../../src/routes/recordings/list.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUPERVISOR_AUTH = {
  uid: 1,
  tenantId: 2,
  role: "supervisor" as const,
  perms: new Set(["recording:list"] as const),
  jti: "test-jti",
  totpVerified: false,
  rawClaims: {} as unknown as Parameters<typeof registerRecordingListRoute>[0],
  userGroupId: 10n,
  allowedCampaigns: [42n, 43n] as bigint[],
};

const ADMIN_AUTH = {
  ...SUPERVISOR_AUTH,
  role: "admin" as const,
  allowedCampaigns: "*" as const,
};

const AGENT_AUTH = {
  ...SUPERVISOR_AUTH,
  role: "agent" as const,
  allowedCampaigns: "*" as const,
};

const NO_PERMS_AUTH = {
  ...SUPERVISOR_AUTH,
  perms: new Set<string>(),
};

function makeRow(overrides = {}) {
  return {
    id: 1000n,
    call_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    start_time: new Date("2026-05-13T14:00:00Z"),
    duration_sec: 120,
    campaign_id: 42n,
    campaign_name: "Summer Campaign",
    user_id: 1n,
    agent_name: "Jane Smith",
    lead_phone: "5555551234",
    lifecycle_state: "available",
    consent_status: "prompted_accepted",
    transcript_status: "completed",
    has_legal_hold: 0,
    size_bytes: 1048576n,
    ...overrides,
  };
}

type MockPrisma = {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};

function buildApp(_auth?: typeof SUPERVISOR_AUTH | null) {
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
  return { app, handlers };
}

function buildRequest(query: Record<string, string | undefined> = {}, authOverride?: unknown) {
  return {
    query,
    ip: "127.0.0.1",
    headers: { "user-agent": "test-agent" },
    id: "req-1",
    auth: authOverride ?? SUPERVISOR_AUTH,
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

describe("GET /api/recordings — list route", () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = {
      $queryRawUnsafe: vi.fn(),
    };
    vi.mocked(getPrisma).mockReturnValue(mockPrisma as unknown as ReturnType<typeof getPrisma>);
  });

  it("returns 401 when auth is missing", async () => {
    const { app } = buildApp(null);
    await registerRecordingListRoute(app);

    const req = { ...buildRequest(), auth: undefined };
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "unauthorized" }));
  });

  it("returns 403 when role lacks recording:list", async () => {
    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, NO_PERMS_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("returns 400 on invalid query params", async () => {
    const { app } = buildApp();
    await registerRecordingListRoute(app);

    // lead_phone_last4 must be exactly 4 digits
    const req = buildRequest({ lead_phone_last4: "12" }, ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it("returns recordings list with next_cursor for admin", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      makeRow({ id: BigInt(1000 - i), call_uuid: `uuid-${i}` }),
    );
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce(rows) // main query (limit+1 = 51)
      .mockResolvedValueOnce([{ cnt: 500n }]); // count query

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({ limit: "50" }, ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    expect(reply._code).toBe(200); // default is 200
    expect(reply.send).toHaveBeenCalled();
    const body = reply._body as { recordings: unknown[]; next_cursor: string | null; total_hint: number };
    expect(body.recordings).toHaveLength(50);
    expect(body.next_cursor).not.toBeNull();
    expect(body.total_hint).toBe(500);
  });

  it("returns null next_cursor on last page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow({ id: BigInt(10 - i) }));
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ cnt: 3n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({ limit: "50" }, ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    const body = reply._body as { recordings: unknown[]; next_cursor: string | null };
    expect(body.recordings).toHaveLength(3);
    expect(body.next_cursor).toBeNull();
  });

  it("masks lead phone for supervisor role", async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeRow({ lead_phone: "5555551234" })])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, SUPERVISOR_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    const body = reply._body as { recordings: Array<{ lead_phone: string }> };
    expect(body.recordings[0].lead_phone).toBe("***-***-1234");
  });

  it("does NOT mask lead phone for admin role", async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeRow({ lead_phone: "5555551234" })])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);
    const body = reply._body as { recordings: Array<{ lead_phone: string }> };
    expect(body.recordings[0].lead_phone).toBe("5555551234");
  });

  it("adds agent scope filter when role is agent", async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeRow({ user_id: 1n })])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, AGENT_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);

    // Query should include the agent uid in WHERE clause
    const queryCall = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(queryCall).toContain(`rl.user_id = ${AGENT_AUTH.uid}`);
  });

  it("adds campaign scope filter for supervisor with allowedCampaigns list", async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: 0n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, SUPERVISOR_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);

    const queryCall = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(queryCall).toContain("IN (42,43)");
  });

  it("writes audit row on every request", async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: 0n }]);

    const { app } = buildApp();
    await registerRecordingListRoute(app);

    const req = buildRequest({}, ADMIN_AUTH);
    const reply = buildReply();

    await app._call("/api/recordings", req, reply);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recording.list",
        tenantId: ADMIN_AUTH.tenantId,
      }),
    );
  });
});
