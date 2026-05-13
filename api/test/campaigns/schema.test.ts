// E01 — Campaign schema / validator unit tests.

import { describe, it, expect } from "vitest";
import { CampaignCreateSchema, CampaignUpdateSchema } from "../../src/routes/campaigns/schema.js";

describe("CampaignCreateSchema", () => {
  const base = {
    id: "test-campaign",
    name: "Test Campaign",
    dial_method: "RATIO",
    dial_timeout_sec: 22,
    lock_ttl_sec: 30, // 22 + 5 = 27, 30 > 27 ✓
    min_hopper_level: 50,
    max_hopper_level: 5000,
    low_water_pct: 25,
    high_water_pct: 90,
  };

  it("accepts a valid minimal campaign", () => {
    const result = CampaignCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects campaign id with invalid chars", () => {
    const result = CampaignCreateSchema.safeParse({ ...base, id: "my campaign!" });
    expect(result.success).toBe(false);
  });

  it("rejects lock_ttl_sec <= dial_timeout_sec + 5", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      dial_timeout_sec: 22,
      lock_ttl_sec: 26, // 22 + 5 = 27, 26 <= 27 ✗
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("lock_ttl_sec");
    }
  });

  it("accepts lock_ttl_sec = dial_timeout_sec + 6", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      dial_timeout_sec: 22,
      lock_ttl_sec: 28, // 22 + 6 = 28, exactly 28 > 27 ✓
    });
    expect(result.success).toBe(true);
  });

  it("rejects min_hopper_level > max_hopper_level", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      min_hopper_level: 1000,
      max_hopper_level: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects low_water_pct >= high_water_pct", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      low_water_pct: 90,
      high_water_pct: 90,
    });
    expect(result.success).toBe(false);
  });

  it("rejects lead_filter_sql with DROP keyword", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      lead_filter_sql: "state = 'TX' DROP TABLE leads",
    });
    expect(result.success).toBe(false);
  });

  it("rejects lead_filter_sql with semicolon", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      lead_filter_sql: "state = 'TX'; DELETE FROM leads",
    });
    expect(result.success).toBe(false);
  });

  it("rejects lead_filter_sql with SQL comment --", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      lead_filter_sql: "state = 'TX' -- comment",
    });
    expect(result.success).toBe(false);
  });

  it("accepts safe lead_filter_sql", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      lead_filter_sql: "state IN ('TX', 'FL') AND rank > 5",
    });
    expect(result.success).toBe(true);
  });

  it("rejects lead_filter_sql with UNION", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      lead_filter_sql: "1=1 UNION SELECT * FROM users",
    });
    expect(result.success).toBe(false);
  });

  it("rejects dial_method with unknown value", () => {
    const result = CampaignCreateSchema.safeParse({
      ...base,
      dial_method: "ROBO",
    });
    expect(result.success).toBe(false);
  });

  it("applies defaults", () => {
    const result = CampaignCreateSchema.safeParse({ id: "x", name: "Y" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dial_method).toBe("MANUAL");
      expect(result.data.dial_level).toBe(1.5);
      expect(result.data.min_hopper_level).toBe(50);
      expect(result.data.max_hopper_level).toBe(5000);
      expect(result.data.dial_statuses).toEqual(["NEW", "NA", "B", "CALLBK"]);
      expect(result.data.multi_list_mix).toBe("EVEN");
      expect(result.data.unknown_tz_policy).toBe("deny");
    }
  });

  it("rejects max_calls_per_lead > 127", () => {
    const result = CampaignCreateSchema.safeParse({ ...base, max_calls_per_lead: 200 });
    expect(result.success).toBe(false);
  });
});

describe("CampaignUpdateSchema", () => {
  it("accepts empty object (all optional)", () => {
    const result = CampaignUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial update", () => {
    const result = CampaignUpdateSchema.safeParse({ name: "New Name", active: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("New Name");
      expect(result.data.active).toBe(false);
    }
  });

  it("rejects invalid lock_ttl cross-validation when both provided", () => {
    const result = CampaignUpdateSchema.safeParse({
      dial_timeout_sec: 30,
      lock_ttl_sec: 30, // <= 30 + 5 = 35
    });
    expect(result.success).toBe(false);
  });

  it("allows lock_ttl update alone (no cross-validation without both fields)", () => {
    // Single-field update — the cross-validation only fires if BOTH fields are present
    const result = CampaignUpdateSchema.safeParse({ lock_ttl_sec: 40 });
    expect(result.success).toBe(true);
  });
});
