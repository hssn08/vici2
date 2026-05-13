/**
 * workers/src/lib/backoff.ts
 *
 * Jitter utility for exponential backoff.
 *
 * jitter(delay, fraction=0.25) returns delay ± (fraction * delay), uniform distribution.
 * Default fraction of 0.25 gives ±25% of the base delay.
 */

/**
 * Apply uniform jitter to a base delay.
 *
 * @param delayMs   Base delay in milliseconds.
 * @param fraction  Jitter fraction (0–1). Default 0.25 (±25%).
 * @returns         Delay in milliseconds with jitter applied.
 */
export function jitter(delayMs: number, fraction = 0.25): number {
  const delta = delayMs * fraction;
  return delayMs - delta + Math.random() * 2 * delta;
}

/**
 * Exponential backoff with optional jitter.
 *
 * @param attempt   Zero-based attempt number.
 * @param baseMs    Base delay in milliseconds.
 * @param maxMs     Maximum delay in milliseconds (default 1 hour).
 * @param jitterFraction  Jitter fraction (default 0.25).
 */
export function exponentialBackoff(
  attempt: number,
  baseMs: number,
  maxMs = 3_600_000,
  jitterFraction = 0.25,
): number {
  const raw = baseMs * 2 ** attempt;
  const capped = Math.min(raw, maxMs);
  return jitter(capped, jitterFraction);
}
