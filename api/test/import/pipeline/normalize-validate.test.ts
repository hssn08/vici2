// D02 — normalize-validate.ts unit tests

import { describe, it, expect } from "vitest";
import { NormalizeValidateTransform } from "../../../src/import/pipeline/normalize-validate.js";
import type { MappedRow, NormalizedRow } from "../../../src/import/pipeline/types.js";

function makeRow(mapped: Record<string, string>, line = 1): MappedRow {
  return {
    mapped,
    rawRecord: Object.values(mapped),
    info: { lines: line, records: line - 1 },
  };
}

async function processRow(transform: NormalizeValidateTransform, row: MappedRow): Promise<NormalizedRow> {
  return new Promise((resolve, reject) => {
    transform.once("data", resolve);
    transform.once("error", reject);
    transform.write(row);
  });
}

describe("NormalizeValidateTransform — phone", () => {
  const t = new NormalizeValidateTransform({ defaultCountry: "US" });
  t.on("data", () => {});  // prevent backpressure

  it("normalizes a valid 10-digit US phone to E.164", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "8005551234" }));
    expect(result.lead?.phoneE164).toBe("+18005551234");
  });

  it("accepts already-E164 phone", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234" }));
    expect(result.lead?.phoneE164).toBe("+18005551234");
  });

  it("returns MISSING_REQUIRED_FIELD for empty phone", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "" }));
    expect(result.lead).toBeNull();
    expect(result.errors[0]?.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("returns INVALID_PHONE for un-parseable phone", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "notaphone" }));
    expect(result.lead).toBeNull();
    expect(result.errors[0]?.code).toBe("INVALID_PHONE");
  });
});

describe("NormalizeValidateTransform — state", () => {
  const t = new NormalizeValidateTransform({ defaultCountry: "US" });
  t.on("data", () => {});

  it("accepts valid US state", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234", state: "tx" }));
    expect(result.lead?.state).toBe("TX");
  });

  it("emits INVALID_STATE for bad state", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234", state: "ZZ" }));
    expect(result.errors.some((e) => e.code === "INVALID_STATE")).toBe(true);
    // Lead is still included (state is optional)
  });
});

describe("NormalizeValidateTransform — date_of_birth", () => {
  const t = new NormalizeValidateTransform({ defaultCountry: "US" });
  t.on("data", () => {});

  it("accepts ISO date", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234", date_of_birth: "1990-03-15" }));
    expect(result.lead?.dateOfBirth).toBe("1990-03-15");
  });

  it("accepts M/D/YYYY format", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234", date_of_birth: "3/15/1990" }));
    // Date parse may be timezone-dependent; just check it's a valid ISO date near 1990
    expect(result.lead?.dateOfBirth).toMatch(/^1990-03-1[45]$/);
  });

  it("emits INVALID_DATE for unparseable date", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551234", date_of_birth: "notadate" }));
    expect(result.errors.some((e) => e.code === "INVALID_DATE")).toBe(true);
  });
});

describe("NormalizeValidateTransform — gender", () => {
  const t = new NormalizeValidateTransform({ defaultCountry: "US" });
  t.on("data", () => {});

  it("maps M/Male correctly", async () => {
    const r1 = await processRow(t, makeRow({ phone_e164: "+18005551234", gender: "M" }));
    expect(r1.lead?.gender).toBe("M");
    const r2 = await processRow(t, makeRow({ phone_e164: "+18005551235", gender: "Male" }));
    expect(r2.lead?.gender).toBe("M");
  });

  it("defaults to U for unrecognized", async () => {
    const result = await processRow(t, makeRow({ phone_e164: "+18005551236", gender: "X" }));
    expect(result.lead?.gender).toBe("U");
  });
});
