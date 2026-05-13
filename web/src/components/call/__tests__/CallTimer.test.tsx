import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CallTimer } from "../CallTimer";
import { useCallStore } from "@/lib/stores/call";

describe("CallTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCallStore.getState().clearCall();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 00:00 when startedAt is null", () => {
    render(<CallTimer />);
    expect(screen.getByRole("time")).toHaveTextContent("00:00");
  });

  it("displays elapsed time in MM:SS format", () => {
    const now = Date.now();
    useCallStore.setState({ phase: "active", startedAt: now });
    render(<CallTimer />);
    // Advance 90 seconds
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.getByRole("time")).toHaveTextContent("01:30");
  });

  it("uses clock arithmetic (no accumulator drift)", () => {
    const now = Date.now();
    useCallStore.setState({ phase: "active", startedAt: now });
    render(<CallTimer />);
    act(() => { vi.advanceTimersByTime(3_600_000); }); // 1 hour
    expect(screen.getByRole("time")).toHaveTextContent("01:00:00");
  });

  it("sets dateTime attribute in seconds", () => {
    const now = Date.now();
    useCallStore.setState({ phase: "active", startedAt: now });
    render(<CallTimer />);
    act(() => { vi.advanceTimersByTime(10_000); });
    const el = screen.getByRole("time");
    // The timer uses requestAnimationFrame which may tick at slightly different times
    const dt = el.getAttribute("dateTime") ?? "";
    expect(dt).toMatch(/^PT\d+S$/);
    const seconds = parseInt(dt.replace("PT", "").replace("S", ""), 10);
    expect(seconds).toBeGreaterThanOrEqual(9);
  });
});
