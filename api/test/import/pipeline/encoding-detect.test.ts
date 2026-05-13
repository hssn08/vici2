// D02 — encoding-detect.ts unit tests

import { describe, it, expect } from "vitest";
import { detectDelimiter } from "../../../src/import/pipeline/encoding-detect.js";

describe("detectDelimiter", () => {
  it("detects comma delimiter", () => {
    const sample = "phone,first_name,last_name\n8005551234,Bob,Smith\n";
    expect(detectDelimiter(sample)).toBe(",");
  });

  it("detects tab delimiter", () => {
    const sample = "phone\tfirst_name\tlast_name\n8005551234\tBob\tSmith\n";
    expect(detectDelimiter(sample)).toBe("\t");
  });

  it("detects semicolon delimiter", () => {
    const sample = "phone;first_name;last_name\n8005551234;Bob;Smith\n";
    expect(detectDelimiter(sample)).toBe(";");
  });

  it("defaults to comma when ambiguous", () => {
    const sample = "hello";
    expect(detectDelimiter(sample)).toBe(",");
  });
});
