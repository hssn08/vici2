// D01 — schemas.ts unit tests

import { describe, it, expect } from "vitest";
import {
  LeadCreateSchema,
  LeadPatchSchema,
  LeadBulkRequestSchema,
  FieldKeyParamSchema,
  LeadListQuerySchema,
} from "../../src/leads/schemas.js";

describe("LeadCreateSchema", () => {
  it("accepts minimal valid input", () => {
    const result = LeadCreateSchema.safeParse({
      list_id: "1",
      phone_e164: "+15551234567",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing phone_e164", () => {
    const result = LeadCreateSchema.safeParse({ list_id: "1" });
    expect(result.success).toBe(false);
  });

  it("rejects missing list_id", () => {
    const result = LeadCreateSchema.safeParse({ phone_e164: "+15551234567" });
    expect(result.success).toBe(false);
  });

  it("rejects status field with non-NEW value", () => {
    const result = LeadCreateSchema.safeParse({
      list_id: "1",
      phone_e164: "+15551234567",
      status: "SALE",
    });
    expect(result.success).toBe(false);
  });

  it("defaults gender to U", () => {
    const result = LeadCreateSchema.safeParse({
      list_id: "1",
      phone_e164: "+15551234567",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gender).toBe("U");
    }
  });

  it("defaults custom_data to {}", () => {
    const result = LeadCreateSchema.safeParse({
      list_id: "1",
      phone_e164: "+15551234567",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.custom_data).toEqual({});
    }
  });
});

describe("LeadPatchSchema", () => {
  it("accepts empty patch", () => {
    const result = LeadPatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects status field (z.never)", () => {
    const result = LeadPatchSchema.safeParse({ status: "SALE" });
    expect(result.success).toBe(false);
  });

  it("accepts version field", () => {
    const result = LeadPatchSchema.safeParse({ version: 3 });
    expect(result.success).toBe(true);
  });

  it("accepts nullable phone_alt", () => {
    const result = LeadPatchSchema.safeParse({ phone_alt: null });
    expect(result.success).toBe(true);
  });
});

describe("LeadBulkRequestSchema", () => {
  it("accepts valid bulk request", () => {
    const result = LeadBulkRequestSchema.safeParse({
      list_id: "1",
      leads: [{ list_id: "1", phone_e164: "+15551234567" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 500 rows", () => {
    const leads = Array.from({ length: 501 }, (_, i) => ({
      list_id: "1",
      phone_e164: `+1555${String(i).padStart(7, "0")}`,
    }));
    const result = LeadBulkRequestSchema.safeParse({ list_id: "1", leads });
    expect(result.success).toBe(false);
  });

  it("rejects empty leads array", () => {
    const result = LeadBulkRequestSchema.safeParse({ list_id: "1", leads: [] });
    expect(result.success).toBe(false);
  });

  it("defaults options to { skipDuplicates: true, dryRun: false, strict: false }", () => {
    const result = LeadBulkRequestSchema.safeParse({
      list_id: "1",
      leads: [{ list_id: "1", phone_e164: "+15551234567" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options.skipDuplicates).toBe(true);
      expect(result.data.options.dryRun).toBe(false);
      expect(result.data.options.strict).toBe(false);
    }
  });
});

describe("FieldKeyParamSchema", () => {
  it("accepts valid key", () => {
    expect(FieldKeyParamSchema.safeParse({ k: "my_field" }).success).toBe(true);
    expect(FieldKeyParamSchema.safeParse({ k: "field123" }).success).toBe(true);
    expect(FieldKeyParamSchema.safeParse({ k: "_private" }).success).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(FieldKeyParamSchema.safeParse({ k: "MyField" }).success).toBe(false);
  });

  it("rejects starting with digit", () => {
    expect(FieldKeyParamSchema.safeParse({ k: "1field" }).success).toBe(false);
  });

  it("rejects too-long key", () => {
    expect(FieldKeyParamSchema.safeParse({ k: "a".repeat(32) }).success).toBe(false);
  });

  it("rejects SQL injection attempt", () => {
    expect(FieldKeyParamSchema.safeParse({ k: "field; DROP TABLE" }).success).toBe(false);
  });
});

describe("LeadListQuerySchema", () => {
  it("applies defaults", () => {
    const result = LeadListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.sort).toBe("modify_at_desc");
    }
  });

  it("rejects limit > 200", () => {
    const result = LeadListQuerySchema.safeParse({ limit: "201" });
    expect(result.success).toBe(false);
  });

  it("rejects limit < 1", () => {
    const result = LeadListQuerySchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });

  it("parses search min 3 chars", () => {
    expect(LeadListQuerySchema.safeParse({ search: "ab" }).success).toBe(false);
    expect(LeadListQuerySchema.safeParse({ search: "abc" }).success).toBe(true);
  });
});
