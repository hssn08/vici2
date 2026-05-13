// D02 — schemas.ts unit tests

import { describe, it, expect } from "vitest";
import { ImportMetaSchema, ColumnMappingSchema, ListImportsQuerySchema } from "../../src/import/schemas.js";

describe("ImportMetaSchema", () => {
  it("accepts minimal valid input", () => {
    const result = ImportMetaSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dnc_policy).toBe("skip");
      expect(result.data.tz_policy).toBe("mark");
      expect(result.data.default_country).toBe("US");
    }
  });

  it("accepts full valid input", () => {
    const result = ImportMetaSchema.safeParse({
      name: "Q2 FL cold list",
      delimiter: "auto",
      encoding: "auto",
      header_row: true,
      dnc_policy: "mark",
      tz_policy: "proceed",
      default_country: "US",
      default_status: "NEW",
      options: {
        lookup_state_from_zip: true,
        persist_raw_errors: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown dnc_policy", () => {
    const result = ImportMetaSchema.safeParse({ dnc_policy: "ignore" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid delimiter", () => {
    const result = ImportMetaSchema.safeParse({ delimiter: "|" });
    expect(result.success).toBe(false);
  });
});

describe("ColumnMappingSchema", () => {
  it("accepts valid mapping", () => {
    const result = ColumnMappingSchema.safeParse({
      version: 1,
      rows: [
        { source: "Phone", target: "phone_e164", transform: "phone" },
        { source: "First Name", target: "first_name", transform: "trim" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects version != 1", () => {
    const result = ColumnMappingSchema.safeParse({
      version: 2,
      rows: [{ source: "Phone", target: "phone_e164" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty rows", () => {
    const result = ColumnMappingSchema.safeParse({
      version: 1,
      rows: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("ListImportsQuerySchema", () => {
  it("applies default limit of 20", () => {
    const result = ListImportsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(20);
  });

  it("clamps limit to 100", () => {
    const result = ListImportsQuerySchema.safeParse({ limit: "200" });
    expect(result.success).toBe(false);
  });

  it("accepts valid status filter", () => {
    const result = ListImportsQuerySchema.safeParse({ status: "running" });
    expect(result.success).toBe(true);
  });
});
