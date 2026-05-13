/**
 * A02 — Custom exponential backoff with jitter for SIP.js reconnect.
 *
 * Wraps SIP.js's fixed reconnectionDelay with our own ladder:
 *   attempt: 1   2   3   4   5   6+
 *   delay s: 0   1   2   4   8   30
 * with ±25% jitter; ceiling 30 s.
 */

const BACKOFF_SCHEDULE = [0, 1, 2, 4, 8]; // seconds
const CEILING_S = 30;
const JITTER = 0.25; // ±25%

/**
 * Returns delay in milliseconds for the given attempt (1-indexed).
 */
export function backoffDelayMs(attempt: number): number {
  const baseS =
    attempt <= BACKOFF_SCHEDULE.length
      ? BACKOFF_SCHEDULE[attempt - 1]
      : CEILING_S;
  const jitterFactor = 1 + (Math.random() * 2 - 1) * JITTER;
  return Math.round(baseS * jitterFactor * 1000);
}

/**
 * Reconnect manager that tracks attempts and provides delay logic.
 * Used inside SipProvider to drive the retry loop.
 */
export class ReconnectManager {
  private attempt = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  reset(): void {
    this.attempt = 0;
    this.cancel();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Schedule `fn` after the next backoff delay.
   * Returns a cleanup function.
   */
  scheduleNext(fn: () => void): () => void {
    this.cancelled = false;
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt);

    this.timerId = setTimeout(() => {
      if (!this.cancelled) fn();
    }, delay);

    return () => this.cancel();
  }

  get currentAttempt(): number {
    return this.attempt;
  }
}
