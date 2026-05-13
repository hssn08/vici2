/**
 * shared/lib/jcs.ts — RFC 8785 JSON Canonicalization Scheme (JCS)
 *
 * Pure-function, zero-dependency implementation matching the spec exactly.
 * Used by:
 *   - AuditWriter: canonicalize JSON payload fields before hashing
 *   - AttestationWorker: canonicalize the attestation object before signing
 *   - AuditVerifier: re-canonicalize for signature verification
 *
 * Key properties:
 *   - Object keys are sorted lexicographically (Unicode code point order)
 *   - No extra whitespace
 *   - Numbers follow IEEE 754 / ES6 JSON.stringify rules
 *   - Unicode U+2028 / U+2029 serialized as escape sequences (per RFC 8785 §3.2.2)
 *
 * This implementation matches MySQL's JSON_EXTRACT($) canonical output for the
 * subset of JSON values we use (no nested arrays of objects with mixed key
 * types beyond what Zod validates).
 *
 * Golden fixtures at test/fixtures/canonicalization/ validate parity with Go
 * and MySQL.
 */

/** Serialize a value to RFC 8785 canonical JSON string. */
export function canonicalize(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return serializeNumber(v);
  if (typeof v === 'string') return serializeString(v);
  if (Array.isArray(v)) return serializeArray(v);
  if (typeof v === 'object') return serializeObject(v as Record<string, unknown>);
  // bigint, symbol, function, undefined — not valid JSON; throw
  throw new TypeError(`JCS: cannot serialize ${typeof v}`);
}

function serializeNumber(n: number): string {
  if (!isFinite(n)) throw new RangeError(`JCS: non-finite number ${n}`);
  // Use ES6 JSON.stringify rules — matches RFC 8785 §3.2.4
  return JSON.stringify(n);
}

// Code points for U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR)
// expressed via String.fromCharCode so no literal U+2028/U+2029 appears in source.
const LS = String.fromCharCode(0x2028); // U+2028 LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // U+2029 PARAGRAPH SEPARATOR
const LS_RE = new RegExp(LS, 'g');
const PS_RE = new RegExp(PS, 'g');

function serializeString(s: string): string {
  // RFC 8785 §3.2.2: U+2028 and U+2029 must be escaped.
  // JSON.stringify already escapes control characters but does NOT always
  // escape these two code points. Replace them explicitly.
  return JSON.stringify(s)
    .replace(LS_RE, '\\u2028')
    .replace(PS_RE, '\\u2029');
}

function serializeArray(arr: unknown[]): string {
  return '[' + arr.map(serializeValue).join(',') + ']';
}

function serializeObject(obj: Record<string, unknown>): string {
  // Sort keys by Unicode code point order (RFC 8785 §3.2.3)
  const sorted = Object.keys(obj).sort();
  const pairs = sorted.map((k) => serializeString(k) + ':' + serializeValue(obj[k]));
  return '{' + pairs.join(',') + '}';
}
