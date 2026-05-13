/**
 * workers/src/jobs/rnd-scrub/batcher.ts
 *
 * N06 — Splits phone lists into API batches (≤1K each).
 * Also determines query mode (api vs sftp) based on list size.
 */

export const API_BATCH_SIZE = 1_000;
export const SFTP_THRESHOLD = 50_000;

export interface PhoneWithConsent {
  phoneE164: string;
  consentDate: Date;
  consentDateSrc: 'pewc' | 'ebr' | 'inferred' | 'fallback';
}

export interface RndQueryItem {
  tn: string;   // E.164
  date: string; // YYYY-MM-DD (consent/as-of date)
}

/**
 * Split an array of phones into chunks of at most `size` items.
 */
export function chunkPhones<T>(phones: T[], size: number): T[][] {
  if (phones.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < phones.length; i += size) {
    chunks.push(phones.slice(i, i + size));
  }
  return chunks;
}

/**
 * Determine query mode based on phone count and env override.
 */
export function selectQueryMode(
  phoneCount: number,
  forced?: 'api' | 'sftp',
): 'api' | 'sftp' {
  if (forced) return forced;
  return phoneCount > SFTP_THRESHOLD ? 'sftp' : 'api';
}

/**
 * Format a Date as YYYY-MM-DD string for the RND query.
 */
export function formatConsentDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convert PhoneWithConsent[] into RndQueryItem[] for the API.
 */
export function toQueryItems(phones: PhoneWithConsent[]): RndQueryItem[] {
  return phones.map((p) => ({
    tn: p.phoneE164,
    date: formatConsentDate(p.consentDate),
  }));
}
