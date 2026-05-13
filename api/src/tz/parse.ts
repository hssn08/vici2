import {
  PhoneNumberUtil,
  PhoneNumberType as LibPhoneNumberType,
  PhoneNumberFormat,
} from 'google-libphonenumber';
import type { NumberType } from './types.js';

const phoneUtil = PhoneNumberUtil.getInstance();

export interface ParsedNumber {
  npa: string;
  nxx: string;
  mapKey: string;  // "${NPA}${NXX}" — used as map key
  numberType: NumberType;
  libNumber: object; // PhoneNumber instance from libphonenumber
}

// Parse cache: E.164 → ParsedNumber (max 4096 entries, simple Map-based LRU)
const PARSE_CACHE_CAP = 4096;
const parseCache = new Map<string, ParsedNumber>();
const parseCacheOrder: string[] = [];

function cachePut(key: string, value: ParsedNumber): void {
  if (parseCache.has(key)) {
    parseCache.set(key, value);
    return;
  }
  if (parseCache.size >= PARSE_CACHE_CAP) {
    const evict = parseCacheOrder.shift();
    if (evict) parseCache.delete(evict);
  }
  parseCache.set(key, value);
  parseCacheOrder.push(key);
}

/** Parse an E.164 phone number, returning NPA, NXX, and type. */
export function parseE164(phone: string): ParsedNumber | null {
  if (!phone) return null;

  const cached = parseCache.get(phone);
  if (cached) return cached;

  try {
    const p = phone.startsWith('+') ? phone : `+${phone}`;
    const parsed = phoneUtil.parse(p, 'US');
    const nat = phoneUtil.getNationalSignificantNumber(parsed);
    if (nat.length < 10) return null;

    const npa = nat.slice(0, 3);
    const nxx = nat.slice(3, 6);
    const numberType = mapLibType(phoneUtil.getNumberType(parsed));

    const result: ParsedNumber = {
      npa,
      nxx,
      mapKey: `${npa}${nxx}`,
      numberType,
      libNumber: parsed,
    };
    cachePut(phone, result);
    return result;
  } catch {
    return null;
  }
}

/** Get IANA timezones for a phone number via libphonenumber (Tier 4 fallback). */
export function getTimezonesForNumber(parsed: ParsedNumber): string[] {
  try {
    // google-libphonenumber doesn't expose getTimezonesForNumber directly in all
    // versions; use the geocoder utility if available, else return empty.
    // We use a dynamic approach to avoid compile-time errors.
    const util = phoneUtil as unknown as { getTimezonesForNumber?: (n: object) => string[] };
    if (typeof util.getTimezonesForNumber === 'function') {
      return util.getTimezonesForNumber(parsed.libNumber) ?? [];
    }
    return [];
  } catch {
    return [];
  }
}

/** isValidUSZip checks for 5-digit or XXXXX-XXXX format. */
export function isValidUSZip(zip?: string): zip is string {
  if (!zip) return false;
  if (zip.length === 5) return /^\d{5}$/.test(zip);
  if (zip.length === 10) return /^\d{5}-\d{4}$/.test(zip);
  return false;
}

/** zipKey extracts the 5-digit numeric zip string. */
export function zipKey(zip: string): string {
  return zip.slice(0, 5);
}

function mapLibType(t: LibPhoneNumberType): NumberType {
  switch (t) {
    case LibPhoneNumberType.FIXED_LINE: return 'FIXED_LINE';
    case LibPhoneNumberType.MOBILE: return 'MOBILE';
    case LibPhoneNumberType.FIXED_LINE_OR_MOBILE: return 'FIXED_OR_MOBILE';
    case LibPhoneNumberType.TOLL_FREE: return 'TOLL_FREE';
    case LibPhoneNumberType.PREMIUM_RATE: return 'PREMIUM_RATE';
    case LibPhoneNumberType.VOIP: return 'VOIP';
    default: return 'UNKNOWN';
  }
}
