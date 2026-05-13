import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNotesSave } from "../useNotesSave";
import { useCallStore } from "@/lib/stores/call";

const mockApiFetch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe("useNotesSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useCallStore.getState().clearCall();
    useCallStore.setState({ callUuid: "call-uuid-1", notes: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces save by 2 seconds", async () => {
    const { result } = renderHook(() => useNotesSave());
    act(() => { result.current.handleChange("hello world"); });
    expect(mockApiFetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/agent/call/call-uuid-1/notes",
      expect.objectContaining({ method: "PATCH", body: { comments: "hello world" } }),
    );
  });

  it("saves immediately on blur", async () => {
    const { result } = renderHook(() => useNotesSave());
    act(() => { result.current.handleChange("blur test"); });
    await act(async () => {
      result.current.handleBlur();
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalled();
  });

  it("returns saved status after blur save", async () => {
    const { result } = renderHook(() => useNotesSave());
    act(() => { result.current.handleChange("status test"); });
    await act(async () => {
      result.current.handleBlur();
      await Promise.resolve();
    });
    expect(result.current.saveStatus).toBe("saved");
  });

  it("reflects note changes in store", () => {
    const { result } = renderHook(() => useNotesSave());
    act(() => { result.current.handleChange("note content"); });
    expect(useCallStore.getState().notes).toBe("note content");
  });

  it("does not save if callUuid is null", async () => {
    useCallStore.setState({ callUuid: null });
    const { result } = renderHook(() => useNotesSave());
    act(() => { result.current.handleChange("no uuid"); });
    await act(async () => {
      result.current.handleBlur();
      await Promise.resolve();
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
