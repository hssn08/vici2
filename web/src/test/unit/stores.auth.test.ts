import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore } from "@/lib/stores/auth";

describe("useAuthStore", () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
  });

  it("starts unauthenticated", () => {
    const s = useAuthStore.getState();
    expect(s.status).toBe("unauthenticated");
    expect(s.accessToken).toBeNull();
    expect(s.user).toBeNull();
  });

  it("setSession populates and marks authenticated", () => {
    useAuthStore.getState().setSession({
      accessToken: "a.b.c",
      accessExp: 9999999999,
      wsToken: "w.s.t",
      user: {
        id: "u1",
        email: "a@b.c",
        role: "agent",
        tenantId: 1,
        displayName: "A",
      },
      sipCreds: null,
    });
    const s = useAuthStore.getState();
    expect(s.status).toBe("authenticated");
    expect(s.accessToken).toBe("a.b.c");
    expect(s.user?.email).toBe("a@b.c");
  });

  it("clearSession resets all fields", () => {
    useAuthStore.getState().setSession({
      accessToken: "a",
      accessExp: 0,
      user: {
        id: "u",
        email: "x@y.z",
        role: "agent",
        tenantId: 1,
        displayName: "X",
      },
    });
    useAuthStore.getState().clearSession();
    const s = useAuthStore.getState();
    expect(s.accessToken).toBeNull();
    expect(s.user).toBeNull();
    expect(s.status).toBe("unauthenticated");
  });

  it("setRefreshing flips status only when authed already", () => {
    useAuthStore.getState().setSession({
      accessToken: "a",
      accessExp: 0,
      user: {
        id: "u",
        email: "x@y.z",
        role: "agent",
        tenantId: 1,
        displayName: "X",
      },
    });
    useAuthStore.getState().setRefreshing(true);
    expect(useAuthStore.getState().status).toBe("refreshing");
    useAuthStore.getState().setRefreshing(false);
    expect(useAuthStore.getState().status).toBe("authenticated");
  });
});
