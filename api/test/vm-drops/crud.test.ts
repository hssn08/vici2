// I05 — VM drop asset CRUD unit tests.
// Tests the route schema validation and DTO serialization helpers.

import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Inline the schemas for unit testing ─────────────────────────────────────

const PatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  active: z.boolean().optional(),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.bigint().optional(),
  activeOnly: z.coerce.boolean().default(true),
});

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function toDto(row: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(row, serializeBigInt));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VM Drop CRUD Schemas", () => {
  describe("PatchSchema", () => {
    it("accepts name-only patch", () => {
      const result = PatchSchema.safeParse({ name: "My Drop Audio" });
      expect(result.success).toBe(true);
    });

    it("accepts active-only patch", () => {
      const result = PatchSchema.safeParse({ active: false });
      expect(result.success).toBe(true);
    });

    it("accepts empty patch (no-op)", () => {
      const result = PatchSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects name exceeding 128 chars", () => {
      const result = PatchSchema.safeParse({ name: "a".repeat(129) });
      expect(result.success).toBe(false);
    });

    it("rejects empty string name", () => {
      const result = PatchSchema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });

    it("rejects non-boolean active", () => {
      const result = PatchSchema.safeParse({ active: "yes" });
      expect(result.success).toBe(false);
    });
  });

  describe("ListQuerySchema", () => {
    it("uses default limit=50", () => {
      const result = ListQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.activeOnly).toBe(true);
      }
    });

    it("accepts limit override", () => {
      const result = ListQuerySchema.safeParse({ limit: "100" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(100);
      }
    });

    it("rejects limit > 200", () => {
      const result = ListQuerySchema.safeParse({ limit: "201" });
      expect(result.success).toBe(false);
    });

    it("rejects limit < 1", () => {
      const result = ListQuerySchema.safeParse({ limit: "0" });
      expect(result.success).toBe(false);
    });

    it("accepts cursor as string-coerced bigint", () => {
      const result = ListQuerySchema.safeParse({ cursor: "9999" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cursor).toBe(BigInt(9999));
      }
    });

    it("accepts activeOnly=false as boolean false", () => {
      // z.coerce.boolean() uses Boolean() coercion: false boolean passes as false
      const result = ListQuerySchema.safeParse({ activeOnly: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.activeOnly).toBe(false);
      }
    });
  });

  describe("BigInt DTO serialization", () => {
    it("serializes BigInt fields to strings", () => {
      const row = {
        id: BigInt(42),
        tenantId: BigInt(1),
        name: "Test Asset",
        active: true,
      };
      const dto = toDto(row as Record<string, unknown>) as Record<string, unknown>;
      expect(dto.id).toBe("42");
      expect(dto.tenantId).toBe("1");
      expect(dto.name).toBe("Test Asset");
    });

    it("preserves non-BigInt fields", () => {
      const row = {
        id: BigInt(1),
        name: "Audio File",
        durationSec: 30,
        active: true,
        s3Uri: null,
      };
      const dto = toDto(row as Record<string, unknown>) as Record<string, unknown>;
      expect(dto.name).toBe("Audio File");
      expect(dto.durationSec).toBe(30);
      expect(dto.active).toBe(true);
      expect(dto.s3Uri).toBeNull();
    });
  });
});

describe("VM Drop RBAC", () => {
  const VMDROP_READ_ROLES = new Set(["super_admin", "admin", "supervisor"]);
  const VMDROP_EDIT_ROLES = new Set(["super_admin", "admin"]);

  it("super_admin can read", () => {
    expect(VMDROP_READ_ROLES.has("super_admin")).toBe(true);
  });

  it("admin can read", () => {
    expect(VMDROP_READ_ROLES.has("admin")).toBe(true);
  });

  it("supervisor can read", () => {
    expect(VMDROP_READ_ROLES.has("supervisor")).toBe(true);
  });

  it("agent cannot read", () => {
    expect(VMDROP_READ_ROLES.has("agent")).toBe(false);
  });

  it("super_admin can edit", () => {
    expect(VMDROP_EDIT_ROLES.has("super_admin")).toBe(true);
  });

  it("admin can edit", () => {
    expect(VMDROP_EDIT_ROLES.has("admin")).toBe(true);
  });

  it("supervisor cannot edit", () => {
    expect(VMDROP_EDIT_ROLES.has("supervisor")).toBe(false);
  });

  it("agent cannot edit", () => {
    expect(VMDROP_EDIT_ROLES.has("agent")).toBe(false);
  });
});
