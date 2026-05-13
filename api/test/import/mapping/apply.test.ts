// D02 — apply.ts unit tests (transform functions)

import { describe, it, expect } from "vitest";
import { applyTransforms, applyMapping, validateMapping } from "../../../src/import/mapping/apply.js";
import type { ColumnMapping } from "../../../../workers/src/jobs/lead-import/types.js";

describe("applyTransforms", () => {
  it("trim removes leading/trailing whitespace", () => {
    expect(applyTransforms("  hello  ", "trim")).toBe("hello");
  });

  it("lower converts to lowercase", () => {
    expect(applyTransforms("FOO@BAR.COM", "lower")).toBe("foo@bar.com");
  });

  it("upper converts to uppercase", () => {
    expect(applyTransforms("tx", "upper")).toBe("TX");
  });

  it("trim,upper chains correctly", () => {
    expect(applyTransforms("  tx  ", "trim,upper")).toBe("TX");
  });

  it("parseInt converts numeric string", () => {
    expect(applyTransforms("42", "parseInt")).toBe("42");
  });

  it("parseFloat converts decimal string", () => {
    expect(applyTransforms("3.14", "parseFloat")).toBe("3.14");
  });

  it("nullify_blank returns blank for whitespace-only", () => {
    // nullify_blank: if trimmed is empty, returns empty string
    expect(applyTransforms("   ", "nullify_blank")).toBe("");
  });

  it("date:MM/dd/yyyy converts to ISO date format", () => {
    const result = applyTransforms("03/15/1990", "date:MM/dd/yyyy");
    // Result is an ISO date string
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("date: with invalid date returns original", () => {
    const result = applyTransforms("notadate", "date:MM/dd/yyyy");
    expect(result).toBe("notadate");
  });

  it("map:k=v replaces matching value", () => {
    const result = applyTransforms("M", "map:M=Male;F=Female");
    expect(result).toBe("Male");
  });

  it("phone transform is a pass-through (normalization in stage 4)", () => {
    expect(applyTransforms("  8005551234  ", "phone")).toBe("8005551234");
  });

  it("unknown transforms are silently ignored", () => {
    expect(applyTransforms("hello", "unknown_transform")).toBe("hello");
  });
});

describe("applyMapping", () => {
  const mapping: ColumnMapping = {
    version: 1,
    rows: [
      { source: "Phone", target: "phone_e164", transform: "trim" },
      { source: "First Name", target: "first_name", transform: "trim" },
      { source: "State", target: "state", transform: "trim,upper" },
    ],
  };

  it("maps record array to target fields", () => {
    const headers = ["Phone", "First Name", "State"];
    const record = ["8005551234", "Bob", "tx"];
    const result = applyMapping(record, headers, mapping);
    expect(result["phone_e164"]).toBe("8005551234");
    expect(result["first_name"]).toBe("Bob");
    expect(result["state"]).toBe("TX");
  });

  it("handles missing source columns gracefully", () => {
    const headers = ["Phone"];
    const record = ["8005551234"];
    const result = applyMapping(record, headers, mapping);
    expect(result["phone_e164"]).toBe("8005551234");
    // Missing columns are not included in result (no key or empty string)
    expect(result["first_name"] == null || result["first_name"] === "").toBe(true);
  });
});

describe("validateMapping", () => {
  it("accepts valid mapping", () => {
    const m = validateMapping({
      version: 1,
      rows: [{ source: "Phone", target: "phone_e164" }],
    });
    expect(m.version).toBe(1);
    expect(m.rows.length).toBe(1);
  });

  it("rejects version != 1", () => {
    expect(() => validateMapping({ version: 2, rows: [] })).toThrow();
  });

  it("rejects non-object", () => {
    expect(() => validateMapping("not an object")).toThrow();
  });
});
