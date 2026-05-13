// D04 — Zod validator unit tests.

import { describe, it, expect } from "vitest";
import {
  StatusCodeSchema,
  HotkeySchema,
  RecycleDelaySchema,
  CategorySchema,
  StatusCreateSchema,
  StatusUpdateSchema,
} from "../../src/statuses/validators.js";

describe("StatusCodeSchema", () => {
  it("accepts valid codes", () => {
    expect(StatusCodeSchema.safeParse("NEW").success).toBe(true);
    expect(StatusCodeSchema.safeParse("SALE").success).toBe(true);
    expect(StatusCodeSchema.safeParse("B-CAR").success).toBe(true);
    expect(StatusCodeSchema.safeParse("NA-CAR").success).toBe(true);
    expect(StatusCodeSchema.safeParse("A").success).toBe(true);
  });

  it("rejects lowercase codes", () => {
    expect(StatusCodeSchema.safeParse("new").success).toBe(false);
    expect(StatusCodeSchema.safeParse("Sale").success).toBe(false);
  });

  it("rejects codes starting with a digit", () => {
    expect(StatusCodeSchema.safeParse("1NEW").success).toBe(false);
  });

  it("rejects codes exceeding 8 chars (D04 max for PATCH; GATEWAY_LIMIT_TRY_LATER is system-only)", () => {
    // The regex allows up to 8 chars (^[A-Z][A-Z0-9_-]{0,7}$)
    // GATEWAY_LIMIT_TRY_LATER is a system status, not creatable via API
    expect(StatusCodeSchema.safeParse("TOOLONGCODE").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(StatusCodeSchema.safeParse("").success).toBe(false);
  });
});

describe("HotkeySchema", () => {
  it("accepts digits 0-9", () => {
    for (let i = 0; i <= 9; i++) {
      expect(HotkeySchema.safeParse(String(i)).success).toBe(true);
    }
  });

  it("accepts null", () => {
    expect(HotkeySchema.safeParse(null).success).toBe(true);
  });

  it("rejects letters", () => {
    expect(HotkeySchema.safeParse("a").success).toBe(false);
    expect(HotkeySchema.safeParse("Z").success).toBe(false);
  });

  it("rejects multi-char strings", () => {
    expect(HotkeySchema.safeParse("12").success).toBe(false);
  });
});

describe("RecycleDelaySchema", () => {
  it("accepts -1 (terminal)", () => {
    expect(RecycleDelaySchema.safeParse(-1).success).toBe(true);
  });

  it("accepts 0 (immediate)", () => {
    expect(RecycleDelaySchema.safeParse(0).success).toBe(true);
  });

  it("accepts positive integers", () => {
    expect(RecycleDelaySchema.safeParse(120).success).toBe(true);
    expect(RecycleDelaySchema.safeParse(86400).success).toBe(true);
  });

  it("accepts null (campaign default)", () => {
    expect(RecycleDelaySchema.safeParse(null).success).toBe(true);
  });

  it("rejects negative integers other than -1", () => {
    expect(RecycleDelaySchema.safeParse(-2).success).toBe(false);
    expect(RecycleDelaySchema.safeParse(-100).success).toBe(false);
  });

  it("rejects floats", () => {
    expect(RecycleDelaySchema.safeParse(1.5).success).toBe(false);
  });
});

describe("CategorySchema", () => {
  it("accepts all valid categories", () => {
    const valid = ["agent-outcome", "system-amd", "system-carrier", "system-compliance", "lifecycle"];
    for (const cat of valid) {
      expect(CategorySchema.safeParse(cat).success).toBe(true);
    }
  });

  it("accepts null", () => {
    expect(CategorySchema.safeParse(null).success).toBe(true);
  });

  it("rejects unknown categories", () => {
    expect(CategorySchema.safeParse("unknown").success).toBe(false);
  });
});

describe("StatusCreateSchema", () => {
  it("accepts a valid create payload", () => {
    const result = StatusCreateSchema.safeParse({
      status: "MYCODE",
      description: "My custom status",
      selectable: true,
      recycleDelaySeconds: 300,
      hotkey: "1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing description", () => {
    const result = StatusCreateSchema.safeParse({ status: "MYCODE" });
    expect(result.success).toBe(false);
  });

  it("applies defaults for optional boolean fields", () => {
    const result = StatusCreateSchema.safeParse({ status: "MYCODE", description: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectable).toBe(true);
      expect(result.data.humanAnswered).toBe(false);
    }
  });
});

describe("StatusUpdateSchema", () => {
  it("accepts partial update", () => {
    const result = StatusUpdateSchema.safeParse({ recycleDelaySeconds: -1 });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no-op update)", () => {
    expect(StatusUpdateSchema.safeParse({}).success).toBe(true);
  });
});
