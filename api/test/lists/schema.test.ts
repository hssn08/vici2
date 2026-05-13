// D07 — List schema unit tests.

import { describe, it, expect } from "vitest";
import {
  ListCreateSchema,
  ListUpdateSchema,
  ListQuerySchema,
  ListSettingsSchema,
  CampaignLinkSchema,
  CampaignLinkUpdateSchema,
  CloneSchema,
  ResetPurgeSchema,
} from "../../src/lists/schema.js";

describe("ListSettingsSchema", () => {
  it("accepts valid settings", () => {
    const r = ListSettingsSchema.safeParse({
      max_attempts: 3,
      recycle_delay_default: 300,
      override_tz: "America/Chicago",
      callable_status_codes: ["NEW", "NA"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.max_attempts).toBe(3);
      expect(r.data.override_tz).toBe("America/Chicago");
    }
  });

  it("applies defaults", () => {
    const r = ListSettingsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.max_attempts).toBe(5);
      expect(r.data.recycle_delay_default).toBe(600);
      expect(r.data.override_tz).toBeNull();
      expect(r.data.callable_status_codes).toEqual(["NEW", "NA", "B", "CALLBK"]);
    }
  });

  it("rejects max_attempts > 99", () => {
    const r = ListSettingsSchema.safeParse({ max_attempts: 100 });
    expect(r.success).toBe(false);
  });

  it("rejects recycle_delay_default > 86400", () => {
    const r = ListSettingsSchema.safeParse({ recycle_delay_default: 90000 });
    expect(r.success).toBe(false);
  });
});

describe("ListCreateSchema", () => {
  it("accepts minimal valid input", () => {
    const r = ListCreateSchema.safeParse({ name: "Test List" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Test List");
      expect(r.data.active).toBe(true);
    }
  });

  it("accepts full input", () => {
    const r = ListCreateSchema.safeParse({
      name: "Full List",
      description: "A detailed list",
      active: false,
      owner_user_id: "42",
      caller_id_override: "+12025551234",
      caller_id_name: "My Campaign",
      settings: { max_attempts: 3 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.owner_user_id).toBe(42n);
      expect(r.data.active).toBe(false);
    }
  });

  it("rejects empty name", () => {
    const r = ListCreateSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects name > 128 chars", () => {
    const r = ListCreateSchema.safeParse({ name: "x".repeat(129) });
    expect(r.success).toBe(false);
  });
});

describe("ListUpdateSchema", () => {
  it("accepts empty update (no-op)", () => {
    const r = ListUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts partial update", () => {
    const r = ListUpdateSchema.safeParse({ active: false, name: "New Name" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.active).toBe(false);
      expect(r.data.name).toBe("New Name");
    }
  });

  it("allows null owner_user_id (unassign)", () => {
    const r = ListUpdateSchema.safeParse({ owner_user_id: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.owner_user_id).toBeNull();
    }
  });
});

describe("ListQuerySchema", () => {
  it("applies defaults", () => {
    const r = ListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.page_size).toBe(50);
    }
  });

  it("coerces page and page_size from strings", () => {
    const r = ListQuerySchema.safeParse({ page: "2", page_size: "100" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(2);
      expect(r.data.page_size).toBe(100);
    }
  });

  it("rejects page_size > 200", () => {
    const r = ListQuerySchema.safeParse({ page_size: "201" });
    expect(r.success).toBe(false);
  });
});

describe("CampaignLinkSchema", () => {
  it("accepts valid campaign link", () => {
    const r = CampaignLinkSchema.safeParse({ campaign_id: "camp-01" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.campaign_id).toBe("camp-01");
      expect(r.data.priority).toBe(0);
      expect(r.data.active).toBe(true);
    }
  });

  it("rejects invalid campaign_id characters", () => {
    const r = CampaignLinkSchema.safeParse({ campaign_id: "camp 01" });
    expect(r.success).toBe(false);
  });
});

describe("CampaignLinkUpdateSchema", () => {
  it("accepts partial update", () => {
    const r = CampaignLinkUpdateSchema.safeParse({ active: false });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.active).toBe(false);
      expect(r.data.priority).toBeUndefined();
    }
  });
});

describe("CloneSchema", () => {
  it("requires name", () => {
    const r = CloneSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("accepts valid clone input", () => {
    const r = CloneSchema.safeParse({ name: "Clone of X", include_deleted: false });
    expect(r.success).toBe(true);
  });
});

describe("ResetPurgeSchema", () => {
  it("accepts empty body", () => {
    const r = ResetPurgeSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts reason", () => {
    const r = ResetPurgeSchema.safeParse({ reason: "Monthly reset" });
    expect(r.success).toBe(true);
  });

  it("rejects reason > 256 chars", () => {
    const r = ResetPurgeSchema.safeParse({ reason: "x".repeat(257) });
    expect(r.success).toBe(false);
  });
});
