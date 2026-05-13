/**
 * workers/src/jobs/rnd-scrub/util.ts
 *
 * N06 — Shared utilities for the RND scrub worker.
 */

/**
 * Mask a phone E.164 for audit logs — show last 4 digits only.
 * e.g. +12025551234 → +12025551****
 */
export function maskPhone(e164: string): string {
  if (e164.length <= 4) return '****';
  return e164.slice(0, e164.length - 4) + '****';
}

/**
 * Sleep for `ms` milliseconds (for rate-limit back-off).
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a Date as YYYY-MM-DD.
 */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Estimate incremental cost in cents for overage queries.
 */
export function estimateOverageCents(
  phoneCount: number,
  pricePerQueryCents: number,
): number {
  return Math.ceil(phoneCount * pricePerQueryCents);
}
