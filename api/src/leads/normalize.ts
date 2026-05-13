// D01 — Phone normalization (PLAN §6)
// Uses libphonenumber-js/min for a compact bundle.

import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js/min";

export class InvalidPhoneError extends Error {
  readonly code = "INVALID_PHONE";
  constructor(raw: string) {
    super(`Invalid phone number: "${raw}"`);
    this.name = "InvalidPhoneError";
  }
}

export interface NormalizeResult {
  e164: string;
  valid: boolean;
}

/**
 * Normalize a raw phone string to E.164.
 * - Throws InvalidPhoneError if the string cannot be parsed at all.
 * - Returns { e164, valid: false } for parseable but potentially invalid
 *   numbers (soft warning path for bulk imports).
 */
export function normalizePhone(raw: string, defaultCountry = "US"): NormalizeResult {
  if (!raw || raw.trim() === "") {
    throw new InvalidPhoneError(raw);
  }
  const parsed = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
  if (!parsed) {
    throw new InvalidPhoneError(raw);
  }
  return { e164: parsed.number, valid: parsed.isValid() };
}

/**
 * Strict normalization — throws if not valid.
 * Used for primary phone_e164 field.
 */
export function strictNormalizePhone(raw: string, defaultCountry = "US"): string {
  const { e164, valid } = normalizePhone(raw, defaultCountry);
  if (!valid) {
    throw new InvalidPhoneError(raw);
  }
  return e164;
}
