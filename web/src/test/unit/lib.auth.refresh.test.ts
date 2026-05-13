import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { refreshAccessToken, _internal } from "@/lib/auth";
import { useAuthStore } from "@/lib/stores/auth";

describe("refreshAccessToken (single-flight)", () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    _internal.resetRefreshState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dedups concurrent calls into one fetch", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    access_token: "new.access.tok",
                    access_exp: Math.floor(Date.now() / 1000) + 900,
                    ws_token: "new.ws.tok",
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                ),
              ),
            5,
          ),
        ),
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const [a, b, c] = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a?.access_token).toBe("new.access.tok");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("clears session on refresh failure", async () => {
    // Seed a session.
    useAuthStore.getState().setSession({
      accessToken: "old",
      accessExp: 0,
      user: {
        id: "u",
        email: "x@y.z",
        role: "agent",
        tenantId: 1,
        displayName: "X",
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const out = await refreshAccessToken();
    expect(out).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
