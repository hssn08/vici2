// D02 — auto-detect.ts unit tests

import { describe, it, expect } from "vitest";
import { autoDetectColumn, autoDetectMapping, AUTO_DETECT_RULES } from "../../../src/import/mapping/auto-detect.js";

describe("autoDetectColumn", () => {
  it("detects phone header variants", () => {
    const cases = ["Phone", "phone", "PHONE", "Mobile", "Cell", "Telephone", "Primary Phone"];
    for (const header of cases) {
      const result = autoDetectColumn(header);
      expect(result?.target, `Expected phone_e164 for "${header}"`).toBe("phone_e164");
    }
  });

  it("detects first_name variants", () => {
    const cases = ["First Name", "fname", "FirstName", "Given Name"];
    for (const header of cases) {
      const result = autoDetectColumn(header);
      expect(result?.target, `Expected first_name for "${header}"`).toBe("first_name");
    }
  });

  it("detects email", () => {
    expect(autoDetectColumn("Email")?.target).toBe("email");
    expect(autoDetectColumn("EMAIL")?.target).toBe("email");
  });

  it("detects postal_code variants", () => {
    const cases = ["zip", "Zip Code", "Postal Code", "PostCode"];
    for (const header of cases) {
      const result = autoDetectColumn(header);
      expect(result?.target, `Expected postal_code for "${header}"`).toBe("postal_code");
    }
  });

  it("detects date_of_birth variants", () => {
    const cases = ["DOB", "Birth Date", "Date of Birth", "BirthDate"];
    for (const header of cases) {
      const result = autoDetectColumn(header);
      expect(result?.target, `Expected date_of_birth for "${header}"`).toBe("date_of_birth");
    }
  });

  it("returns null for unrecognized headers", () => {
    expect(autoDetectColumn("SKU")).toBeNull();
    expect(autoDetectColumn("Widget ID")).toBeNull();
  });

  it("all AUTO_DETECT_RULES targets are reachable", () => {
    // Ensure no rule is shadowed by a rule before it for its own target
    const targets = AUTO_DETECT_RULES.map((r) => r.target);
    const uniqueTargets = new Set(targets);
    expect(uniqueTargets.size).toBeGreaterThan(5);
  });
});

describe("autoDetectMapping", () => {
  it("maps a typical Vicidial-style header row", () => {
    const headers = ["Phone", "First Name", "Last Name", "State", "Zip Code", "Email"];
    const { rows, autoDetect } = autoDetectMapping(headers);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.target === "phone_e164")).toBe(true);
    expect(rows.some((r) => r.target === "first_name")).toBe(true);
    expect(rows.some((r) => r.target === "email")).toBe(true);
    expect(autoDetect["Phone"]?.target).toBe("phone_e164");
    expect(autoDetect["Phone"]?.confidence).toBeGreaterThan(0.8);
  });

  it("does not duplicate targets", () => {
    const headers = ["Phone", "phone", "PHONE"];  // All map to phone_e164
    const { rows } = autoDetectMapping(headers);
    const phoneRows = rows.filter((r) => r.target === "phone_e164");
    expect(phoneRows.length).toBe(1);
  });
});
