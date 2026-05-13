/**
 * A02 unit tests — reconnect.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backoffDelayMs, ReconnectManager } from "@/lib/sip/reconnect";

describe("backoffDelayMs", () => {
  it("returns 0ms (±25%) for attempt 1", () => {
    // attempt 1 → base 0s → jitter on 0 is still 0
    expect(backoffDelayMs(1)).toBe(0);
  });

  it("returns ~1000ms (±25%) for attempt 2", () => {
    const delay = backoffDelayMs(2);
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("returns ~2000ms (±25%) for attempt 3", () => {
    const delay = backoffDelayMs(3);
    expect(delay).toBeGreaterThanOrEqual(1500);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it("returns ~4000ms (±25%) for attempt 4", () => {
    const delay = backoffDelayMs(4);
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("caps at 30s (±25%) for attempt 6+", () => {
    const delay = backoffDelayMs(6);
    expect(delay).toBeGreaterThanOrEqual(22500);
    expect(delay).toBeLessThanOrEqual(37500);
  });

  it("caps at 30s (±25%) for very large attempt numbers", () => {
    const delay = backoffDelayMs(100);
    expect(delay).toBeGreaterThanOrEqual(22500);
    expect(delay).toBeLessThanOrEqual(37500);
  });
});

describe("ReconnectManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments attempt on scheduleNext", () => {
    const mgr = new ReconnectManager();
    expect(mgr.currentAttempt).toBe(0);
    mgr.scheduleNext(() => undefined);
    expect(mgr.currentAttempt).toBe(1);
    mgr.cancel();
  });

  it("calls fn after delay when not cancelled", async () => {
    const mgr = new ReconnectManager();
    const fn = vi.fn();
    mgr.scheduleNext(fn);
    // attempt 1 → 0ms delay
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledOnce();
    mgr.cancel();
  });

  it("does NOT call fn after cancel()", () => {
    const mgr = new ReconnectManager();
    const fn = vi.fn();
    mgr.scheduleNext(fn);
    mgr.cancel();
    vi.runAllTimers();
    expect(fn).not.toHaveBeenCalled();
  });

  it("resets attempt count on reset()", () => {
    const mgr = new ReconnectManager();
    mgr.scheduleNext(() => undefined);
    mgr.scheduleNext(() => undefined);
    mgr.reset();
    expect(mgr.currentAttempt).toBe(0);
  });
});
