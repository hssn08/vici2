import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWrapupTimer } from "../useWrapupTimer";
import { useCallStore } from "@/lib/stores/call";

const mockApiFetch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe("useWrapupTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useCallStore.getState().clearCall();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns totalSeconds when not in wrapup phase", () => {
    useCallStore.setState({
      phase: "active",
      campaign: { id: 1, name: "T", recording_mode: "NEVER", wrapup_seconds: 45, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    const { result } = renderHook(() => useWrapupTimer());
    expect(result.current.secondsLeft).toBe(45);
  });

  it("counts down from wrapup_seconds", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    useCallStore.setState({
      phase: "wrapup",
      wrapupStartAt: now,
      campaign: { id: 1, name: "T", recording_mode: "NEVER", wrapup_seconds: 60, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    const { result } = renderHook(() => useWrapupTimer());
    // Advance system time AND timer together so Date.now() returns a later value
    act(() => {
      vi.setSystemTime(now + 20_000);
      vi.advanceTimersByTime(20_000);
    });
    // After 20 seconds, should be less than 60
    expect(result.current.secondsLeft).toBeLessThan(60);
    expect(result.current.secondsLeft).toBeGreaterThanOrEqual(0);
  });

  it("auto-submits NA when timer reaches 0", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: now,
      campaign: { id: 1, name: "T", recording_mode: "NEVER", wrapup_seconds: 5, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    renderHook(() => useWrapupTimer());
    await act(async () => {
      vi.setSystemTime(now + 6000);
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/agent/dispo",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          status: "NA",
          comments: expect.stringContaining("[auto-dispo wrapup expired]"),
        }),
      }),
    );
  }, 10000);

  it("resetTimer extends the countdown", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    useCallStore.setState({
      phase: "wrapup",
      wrapupStartAt: now,
      campaign: { id: 1, name: "T", recording_mode: "NEVER", wrapup_seconds: 60, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    const { result } = renderHook(() => useWrapupTimer());
    act(() => {
      vi.setSystemTime(now + 30_000);
      vi.advanceTimersByTime(30_000);
    });
    const before = result.current.secondsLeft;
    act(() => { result.current.resetTimer(); });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.secondsLeft).toBeGreaterThan(before);
  });
});
