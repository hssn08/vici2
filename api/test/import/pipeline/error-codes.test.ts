// D02 — error-codes.ts exhaustiveness test

import { describe, it, expect } from "vitest";
import { ERROR_CODES, ERROR_CODE_SET, assertValidErrorCode } from "../../../src/import/pipeline/error-codes.js";

describe("ERROR_CODES vocabulary", () => {
  it("contains exactly 18 frozen codes", () => {
    expect(ERROR_CODES.length).toBe(18);
  });

  it("ERROR_CODE_SET matches ERROR_CODES array", () => {
    expect(ERROR_CODE_SET.size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_SET.has(code)).toBe(true);
    }
  });

  it("assertValidErrorCode accepts all valid codes", () => {
    for (const code of ERROR_CODES) {
      expect(() => assertValidErrorCode(code)).not.toThrow();
    }
  });

  it("assertValidErrorCode throws on unknown code", () => {
    expect(() => assertValidErrorCode("MADE_UP_CODE")).toThrow(/unknown error code/);
  });

  it("contains the 18 specific codes from PLAN §10.2", () => {
    const requiredCodes = [
      "INVALID_PHONE",
      "MISSING_REQUIRED_FIELD",
      "FIELD_COUNT_MISMATCH",
      "CUSTOM_DATA_SCHEMA_FAIL",
      "INVALID_STATE",
      "INVALID_DATE",
      "DUPLICATE_IN_FILE",
      "DUPLICATE_IN_LIST",
      "DUPLICATE_IN_TENANT",
      "DNC_BLOCKED",
      "DNC_WARN",
      "NO_TIMEZONE",
      "TZ_BLOCKED_WARN",
      "MAX_RECORD_SIZE_EXCEEDED",
      "HEADER_MISMATCH",
      "UNSUPPORTED_ENCODING",
      "MAX_ERRORS_EXCEEDED",
      "DB_TRANSIENT",
    ] as const;

    for (const code of requiredCodes) {
      expect(ERROR_CODE_SET.has(code), `Missing code: ${code}`).toBe(true);
    }
  });
});
