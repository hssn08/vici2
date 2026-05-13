// A08 — Unit tests for callback utilities and hooks

import { describe, it, expect, vi } from "vitest";
import {
  isOutsideTcpaWindow,
  formatCallbackTime,
  formatLeadLocalTime,
  defaultCallbackTime,
  toDateTimeLocalValue,
  localDateTimeToIso,
  maskPhone,
  mapApiError,
  ERROR_MESSAGES,
} from "@/lib/types/callbacks";

// ---------------------------------------------------------------------------
// isOutsideTcpaWindow
// ---------------------------------------------------------------------------
describe("isOutsideTcpaWindow", () => {
  it("returns false when leadTzIana is null", () => {
    expect(isOutsideTcpaWindow("2026-06-15T14:00:00.000Z", null)).toBe(false);
  });

  it("returns false for a valid time inside window (10am LA = 17:00 UTC in summer)", () => {
    // 10am America/Los_Angeles = UTC-7 in summer → 17:00 UTC
    expect(
      isOutsideTcpaWindow("2026-07-15T17:00:00.000Z", "America/Los_Angeles"),
    ).toBe(false);
  });

  it("returns true for 7am local time (before TCPA window)", () => {
    // 7am America/Los_Angeles (UTC-7 summer) = 14:00 UTC
    expect(
      isOutsideTcpaWindow("2026-07-15T14:00:00.000Z", "America/Los_Angeles"),
    ).toBe(true);
  });

  it("returns true for 9pm (21:00) local time — on the boundary, outside", () => {
    // 9pm America/New_York (UTC-4 summer) = 01:00 UTC next day
    expect(
      isOutsideTcpaWindow("2026-07-16T01:00:00.000Z", "America/New_York"),
    ).toBe(true);
  });

  it("returns false for 8pm (20:00) local time — last hour inside window", () => {
    // 8pm America/New_York (UTC-4 summer) = 00:00 UTC next day
    expect(
      isOutsideTcpaWindow("2026-07-16T00:00:00.000Z", "America/New_York"),
    ).toBe(false);
  });

  it("returns false for unknown timezone (graceful)", () => {
    expect(
      isOutsideTcpaWindow("2026-06-15T14:00:00.000Z", "Invalid/Timezone"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maskPhone
// ---------------------------------------------------------------------------
describe("maskPhone", () => {
  it("shows last 4 digits", () => {
    expect(maskPhone("+15551234567")).toBe("•••-••••-4567");
  });

  it("returns dash for undefined", () => {
    expect(maskPhone(undefined)).toBe("—");
  });

  it("returns dash for empty string", () => {
    expect(maskPhone("")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// defaultCallbackTime
// ---------------------------------------------------------------------------
describe("defaultCallbackTime", () => {
  it("returns a datetime-local string in the future", () => {
    const val = defaultCallbackTime();
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const d = new Date(val);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 10am time", () => {
    const val = defaultCallbackTime();
    // ends in T10:00
    expect(val).toMatch(/T10:00$/);
  });

  it("skips weekends", () => {
    // Mock date to a Friday so +1 day would be Saturday
    const FridayFeb13 = new Date("2026-02-13T12:00:00Z");
    vi.setSystemTime(FridayFeb13);
    const val = defaultCallbackTime();
    const d = new Date(val);
    // Monday Feb 16
    expect(d.getDay()).not.toBe(0); // not Sunday
    expect(d.getDay()).not.toBe(6); // not Saturday
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// toDateTimeLocalValue
// ---------------------------------------------------------------------------
describe("toDateTimeLocalValue", () => {
  it("formats a Date as YYYY-MM-DDTHH:mm", () => {
    const d = new Date(2026, 5, 15, 14, 30); // June 15 2026, 2:30pm local
    const val = toDateTimeLocalValue(d);
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(val).toContain("T14:30");
  });
});

// ---------------------------------------------------------------------------
// localDateTimeToIso
// ---------------------------------------------------------------------------
describe("localDateTimeToIso", () => {
  it("converts datetime-local string to ISO UTC", () => {
    const local = "2026-06-15T14:00";
    const iso = localDateTimeToIso(local);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The parsed UTC date should match what new Date() returns
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

// ---------------------------------------------------------------------------
// mapApiError
// ---------------------------------------------------------------------------
describe("mapApiError", () => {
  it("maps known error codes", () => {
    expect(mapApiError("callback_too_soon")).toBe(
      ERROR_MESSAGES.callback_too_soon,
    );
    expect(mapApiError("callback_terminal")).toBe(
      ERROR_MESSAGES.callback_terminal,
    );
  });

  it("returns fallback for unknown codes", () => {
    expect(mapApiError("mystery_code")).toBe("An unexpected error occurred");
  });
});

// ---------------------------------------------------------------------------
// formatCallbackTime / formatLeadLocalTime (smoke tests)
// ---------------------------------------------------------------------------
describe("formatCallbackTime", () => {
  it("returns a non-empty string", () => {
    const result = formatCallbackTime(
      "2026-07-15T17:00:00.000Z",
      "America/New_York",
    );
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatLeadLocalTime", () => {
  it("includes a timezone abbreviation", () => {
    const result = formatLeadLocalTime(
      "2026-07-15T17:00:00.000Z",
      "America/Chicago",
    );
    expect(result).toMatch(/[A-Z]{2,4}/); // e.g. CDT, CST
  });
});
