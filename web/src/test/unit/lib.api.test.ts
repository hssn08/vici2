import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/auth";
import { _internal } from "@/lib/auth";

describe("apiFetch 401 → refresh → retry", () => {
  beforeEach(() => {
    useAuthStore.getState().setSession({
      accessToken: "old.token",
      accessExp: 9999999999,
      user: {
        id: "u",
        email: "x@y.z",
        role: "agent",
        tenantId: 1,
        displayName: "X",
      },
    });
    _internal.resetRefreshState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once after a successful refresh", async () => {
    const fetchMock = vi.fn();
    // 1st call: 401 from /api/leads/1
    // 2nd call: 200 from /api/auth/refresh
    // 3rd call: 200 from /api/leads/1 retry
    fetchMock
      .mockResolvedValueOnce(
        new Response("", { status: 401, statusText: "Unauthorized" }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new.token",
            access_exp: 9999999999,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const body = await apiFetch<{ ok: boolean }>("/api/leads/1");
    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().accessToken).toBe("new.token");
  });

  it("propagates ApiError for non-401 failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "lead.not_found", message: "no" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    await expect(apiFetch("/api/leads/9")).rejects.toBeInstanceOf(ApiError);
  });
});
