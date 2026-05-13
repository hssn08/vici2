/**
 * W02 — PII masking for job.data and job.returnvalue.
 *
 * Applied server-side before all API responses unless X-Jobs-Unmask: 1
 * and super_admin role are both present.
 *
 * Masking rules:
 *   1. String values matching NANP phone regex → "***REDACTED***"
 *   2. String values matching email regex → "***REDACTED***"
 *   3. Field whose key (case-insensitive) matches PII_KEY_NAMES → "***REDACTED***"
 *
 * 64 KB truncation: after masking, if JSON size > 65536 bytes, replace with
 * a sentinel object and set _dataTruncated = true.
 */

export const REDACTED = '***REDACTED***';

/** NANP phone number regex (loose — catches all realistic formats). */
const PHONE_RE = /^[+]?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/; // eslint-disable-line no-useless-escape -- regex requires literal hyphen in character classes for NANP matching

/** Email regex. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PII key names (case-insensitive match). */
const PII_KEY_NAMES = new Set([
  'ssn',
  'social_security',
  'dob',
  'date_of_birth',
  'credit_card',
  'pan',
  'card_number',
]);

function maskValue(key: string, value: unknown): unknown {
  // key-based masking regardless of value type
  if (PII_KEY_NAMES.has(key.toLowerCase())) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    if (PHONE_RE.test(value.trim()) || EMAIL_RE.test(value.trim())) {
      return REDACTED;
    }
  }
  return value;
}

/**
 * Recursively mask PII in an arbitrary JSON-compatible value.
 * Returns [maskedValue, didRedact].
 */
export function maskJobData(data: unknown): { masked: unknown; redacted: boolean } {
  let redacted = false;

  function walk(key: string, val: unknown): unknown {
    if (val === null || val === undefined) return val;

    if (Array.isArray(val)) {
      return val.map((item, i) => walk(String(i), item));
    }

    if (typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const masked = maskValue(k, v);
        if (masked === REDACTED) {
          out[k] = REDACTED;
          redacted = true;
        } else {
          out[k] = walk(k, v);
        }
      }
      return out;
    }

    // scalar
    const m = maskValue(key, val);
    if (m === REDACTED) {
      redacted = true;
      return REDACTED;
    }
    return val;
  }

  const masked = walk('__root__', data);
  return { masked, redacted };
}

const MAX_BYTES = 65_536;

export interface MaskResult {
  data: unknown;
  truncated: boolean;
  masked: boolean;
}

/**
 * Full pipeline: mask → truncate → return result envelope.
 */
export function maskAndTruncate(raw: unknown): MaskResult {
  const { masked, redacted } = maskJobData(raw);

  const serialized = JSON.stringify(masked);
  if (serialized !== undefined && serialized.length > MAX_BYTES) {
    return {
      data: { _truncated: true, _message: 'Field exceeds 64 KB limit. Use CLI tools for full inspection.' },
      truncated: true,
      masked: redacted,
    };
  }

  return { data: masked, truncated: false, masked: redacted };
}
