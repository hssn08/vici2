import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/navigation
const mockReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// Mock api
const mockPost = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/api", () => ({
  api: { post: (...args: unknown[]) => mockPost(...args) },
}));

import { useCallStore } from "@/lib/stores/call";
import { renderHook } from "@testing-library/react";
import { useAutoDialRouter } from "@/app/(agent)/auto/_components/useAutoDialRouter";

describe("useAutoDialRouter", () => {
  beforeEach(() => {
    useCallStore.getState().clearCall();
    mockReplace.mockClear();
    mockPost.mockClear().mockResolvedValue({ ok: true });
  });

  it("navigates to /dial when dialMode is null (manual)", async () => {
    const { result } = renderHook(() => useAutoDialRouter());
    expect(result.current.isAutoDialMode).toBe(false);
    await result.current.handleDispoComplete();
    expect(mockReplace).toHaveBeenCalledWith("/dial");
  });

  it("navigates to /dial when dialMode is manual", async () => {
    useCallStore.setState({ dialMode: "manual" });
    const { result } = renderHook(() => useAutoDialRouter());
    expect(result.current.isAutoDialMode).toBe(false);
    await result.current.handleDispoComplete();
    expect(mockReplace).toHaveBeenCalledWith("/dial");
  });

  it("POSTs paused + navigates to /auto when pendingPauseAfterCall=true", async () => {
    useCallStore.setState({
      dialMode: "progressive",
      pendingPauseAfterCall: true,
      pendingPauseCode: "BREAK",
      campaign: {
        id: 1,
        name: "Test",
        dial_method: "PROGRESSIVE",
        recording_mode: "ALL",
        wrapup_seconds: 30,
        hangup_grace_seconds: 5,
        hot_keys_active: true,
        webform_url: null,
        auto_ready_after_wrapup: true,
        preview_allowed_seconds: 0,
      },
    });
    const { result } = renderHook(() => useAutoDialRouter());
    await result.current.handleDispoComplete();
    expect(mockPost).toHaveBeenCalledWith(
      "/api/agent/state",
      expect.objectContaining({ status: "paused" }),
    );
    expect(mockReplace).toHaveBeenCalledWith("/auto");
    // pendingPause cleared
    expect(useCallStore.getState().pendingPauseAfterCall).toBe(false);
  });

  it("POSTs ready + navigates to /auto when auto_ready_after_wrapup=true", async () => {
    useCallStore.setState({
      dialMode: "predictive",
      pendingPauseAfterCall: false,
      campaign: {
        id: 1,
        name: "Test",
        dial_method: "PREDICTIVE",
        recording_mode: "ALL",
        wrapup_seconds: 30,
        hangup_grace_seconds: 5,
        hot_keys_active: true,
        webform_url: null,
        auto_ready_after_wrapup: true,
        preview_allowed_seconds: 0,
      },
    });
    const { result } = renderHook(() => useAutoDialRouter());
    await result.current.handleDispoComplete();
    expect(mockPost).toHaveBeenCalledWith("/api/agent/state", { status: "ready" });
    expect(mockReplace).toHaveBeenCalledWith("/auto");
  });

  it("navigates to /auto PAUSED when auto_ready_after_wrapup=false and no pendingPause", async () => {
    useCallStore.setState({
      dialMode: "progressive",
      pendingPauseAfterCall: false,
      campaign: {
        id: 1,
        name: "Test",
        dial_method: "PROGRESSIVE",
        recording_mode: "ALL",
        wrapup_seconds: 30,
        hangup_grace_seconds: 5,
        hot_keys_active: true,
        webform_url: null,
        auto_ready_after_wrapup: false,
        preview_allowed_seconds: 0,
      },
    });
    const { result } = renderHook(() => useAutoDialRouter());
    await result.current.handleDispoComplete();
    expect(mockPost).not.toHaveBeenCalledWith("/api/agent/state", expect.anything());
    expect(mockReplace).toHaveBeenCalledWith("/auto");
  });
});
