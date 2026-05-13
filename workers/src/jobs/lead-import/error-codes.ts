// D02 — FROZEN error code vocabulary (PLAN §10.2)
// Adding a new code requires updating this file + tests.

export const ERROR_CODES = [
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

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

/** Exhaustiveness guard: throws if code is not in the frozen vocabulary. */
export function assertValidErrorCode(code: string): ErrorCode {
  if (!ERROR_CODE_SET.has(code)) {
    throw new Error(`D02 invariant violation: unknown error code "${code}"`);
  }
  return code as ErrorCode;
}
