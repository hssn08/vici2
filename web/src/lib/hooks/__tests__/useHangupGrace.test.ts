import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHangupGrace } from "../useHangupGrace";
import { useCallStore } from "@/lib/stores/call";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("useHangupGrace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCallStore.getState().clearCall();
    useCallStore.setState({
      callUuid: "call-1",
      phase: "active",
      campaign: {
        id: 1,
        name: "Test",
        recording_mode: "NEVER",
        wrapup_seconds: 60,
        hangup_grace_seconds: 5,
        hot_keys_active: true,
        webform_url: null,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("triggerHangup immediately sets phase to wrapup", () => {
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    expect(useCallStore.getState().phase).toBe("wrapup");
  });

  it("triggerHangup sets grace active", () => {
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    expect(useCallStore.getState().hangupGraceActive).toBe(true);
    expect(result.current.graceActive).toBe(true);
  });

  it("cancelHangup within grace reverses phase to active", () => {
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    act(() => { result.current.cancelHangup(); });
    expect(useCallStore.getState().phase).toBe("active");
    expect(useCallStore.getState().hangupGraceActive).toBe(false);
  });

  it("fires POST /hangup after grace expires", async () => {
    const { apiFetch } = await import("@/lib/api");
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    act(() => { vi.advanceTimersByTime(5100); });
    await act(async () => { await Promise.resolve(); });
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/agent/call/call-1/hangup",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not call POST /hangup if cancelled before grace expires", async () => {
    const { apiFetch } = await import("@/lib/api");
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    act(() => { result.current.cancelHangup(); });
    act(() => { vi.advanceTimersByTime(5100); });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("does not trigger grace when phase is already wrapup", () => {
    useCallStore.setState({ phase: "wrapup" });
    const { result } = renderHook(() => useHangupGrace());
    act(() => { result.current.triggerHangup(); });
    expect(useCallStore.getState().hangupGraceActive).toBe(false);
  });
});
