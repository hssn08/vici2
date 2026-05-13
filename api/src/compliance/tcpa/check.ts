/**
 * C01 TCPA time-window gate — TypeScript mirror.
 *
 * Uses the same rule matrix (rules.gen.ts) and holiday calendar (holidays.gen.ts)
 * as the Go canonical implementation. No gRPC round-trip; pure function.
 *
 * Usage:
 *   const result = await check({ phoneE164, knownTimezone, state, enforcementPoint, ... });
 *   if (result.outcome !== 'ALLOW') throw new AppError('OUTSIDE_CALL_WINDOW', result);
 */

import type { CheckRequest, CheckResult, Confidence, Window } from './types.js';
import { REASONS } from './types.js';
import { FED_FLOOR, STATE_RULES } from './rules.gen.js';
import { STATE_HOLIDAYS } from './holidays.gen.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Seconds since local midnight for a given Date in a given IANA timezone. */
function secondsSinceMidnight(d: Date, tzIana: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzIana,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): number =>
    parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  // hour can be 24 when Intl reports midnight as 24:00:00
  const h = get('hour') % 24;
  const m = get('minute');
  const s = get('second');
  return h * 3600 + m * 60 + s;
}

/** Returns the weekday index (0=Sun … 6=Sat) in the given timezone. */
function localDow(d: Date, tzIana: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzIana,
    weekday: 'short',
  });
  const day = fmt.format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

/** Returns "YYYY-MM-DD" in the given timezone. */
function localDateISO(d: Date, tzIana: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tzIana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // en-CA gives ISO format
}

/** Narrow window to the most restrictive of a and b. */
function intersect(a: Window, b: Window): Window {
  if (!a || a.openLocal === 0 && a.closeLocal === 0) return b;
  if (!b || b.openLocal === 0 && b.closeLocal === 0) return a;
  return {
    openLocal: Math.max(a.openLocal, b.openLocal),
    closeLocal: Math.min(a.closeLocal, b.closeLocal),
  };
}

/** Returns true if window is a blackout (open >= close and not zero). */
function isBlackout(w: Window): boolean {
  return w.openLocal >= w.closeLocal && !(w.openLocal === 0 && w.closeLocal === 0);
}

/**
 * nextDayOpenMs returns the next local-window open time (as a UTC ms timestamp)
 * after the given date in the given timezone.
 */
function nextDayOpenMs(
  d: Date,
  tzIana: string,
  openSec: number,
  state: string | undefined,
  hols: Set<string> | undefined,
): number {
  // Step forward one day at a time (max 14).
  let candidate = new Date(d.getTime() + 86400_000);
  for (let i = 0; i < 14; i++) {
    const dow = localDow(candidate, tzIana);
    const dateISO = localDateISO(candidate, tzIana);
    const rule = state ? STATE_RULES[state] : undefined;
    const isHol = hols?.has(dateISO) ?? false;
    const isBlkDow = rule ? isBlackout(rule.perDow[dow] ?? { openLocal: 0, closeLocal: 0 }) : false;
    if (isHol || isBlkDow) {
      candidate = new Date(candidate.getTime() + 86400_000);
      continue;
    }
    // Compute midnight local for candidate day in UTC.
    const midnightLocal = localMidnightUtcMs(candidate, tzIana);
    return midnightLocal + openSec * 1000;
  }
  // Fallback: 7 days from now.
  return d.getTime() + 7 * 86400_000 + FED_FLOOR.openLocal * 1000;
}

/**
 * Returns the UTC ms timestamp of local midnight for the calendar day
 * containing `d` in the given timezone.
 */
function localMidnightUtcMs(d: Date, tzIana: string): number {
  const dateISO = localDateISO(d, tzIana);
  // Parse as if UTC, then shift by the zone offset.
  const midnightUTC = new Date(dateISO + 'T00:00:00Z').getTime();
  // Find zone offset at the given instant.
  const offsetMs = getZoneOffsetMs(d, tzIana);
  return midnightUTC - offsetMs;
}

/**
 * Returns the zone offset in ms (positive = east of UTC) for `d` in `tzIana`.
 */
function getZoneOffsetMs(d: Date, tzIana: string): number {
  // Use two Intl formatters to extract hour difference.
  const utcH = d.getUTCHours();
  const utcM = d.getUTCMinutes();

  const localFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzIana,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = localFmt.formatToParts(d);
  const localH = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const localM = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);

  const diffMin = (localH * 60 + localM) - (utcH * 60 + utcM);
  return diffMin * 60 * 1000;
}

// ── TZ Resolution (stub — delegates to D03 in production) ────────────────

interface ResolvedTz {
  iana: string;
  confidence: Confidence;
}

/**
 * resolveTimezone is a thin stub that uses knownTimezone directly, or
 * falls back to state-based heuristics. Production wires in D03.
 */
function resolveTimezone(req: CheckRequest): ResolvedTz | null {
  if (req.knownTimezone) {
    return { iana: req.knownTimezone, confidence: 'KNOWN' };
  }
  // State-based single-tz fallback (same as Go StubResolver)
  const stateTz: Record<string, string> = {
    HI: 'Pacific/Honolulu',
    AK: 'America/Anchorage',
    AZ: 'America/Phoenix',
    AS: 'Pacific/Pago_Pago',
    GU: 'Pacific/Guam',
    MP: 'Pacific/Guam',
    PR: 'America/Puerto_Rico',
    VI: 'America/Puerto_Rico',
  };
  if (req.state && stateTz[req.state]) {
    return { iana: stateTz[req.state]!, confidence: 'STATE_DEFAULT' };
  }
  return null;
}

// ── Main Check function ──────────────────────────────────────────────────

/**
 * check evaluates the TCPA calling-window gate for the given request.
 *
 * @returns A CheckResult with outcome ALLOW, SKIP_UNTIL, or BLOCK_INVALID.
 */
export async function check(req: CheckRequest): Promise<CheckResult> {
  const now = req.when ?? new Date();
  const policy = req.unknownTzPolicy ?? 'deny';

  // Step 1: resolve TZ
  const resolved = resolveTimezone(req);
  if (!resolved) {
    if (policy === 'warn_pass') {
      return {
        outcome: 'ALLOW',
        confidence: 'NONE',
        reason: REASONS.UNKNOWN_TZ_WARN_PASS,
        ruleApplied: 'campaign_warn_pass',
      };
    }
    return {
      outcome: 'BLOCK_INVALID',
      confidence: 'NONE',
      reason: REASONS.NO_TIMEZONE,
      ruleApplied: 'policy_deny',
    };
  }

  const { iana: tzIana, confidence } = resolved;

  // Step 2: compute called-party local time components
  const partyElapsed = secondsSinceMidnight(now, tzIana); // seconds
  const partyMins = Math.floor(partyElapsed / 60) * 60;   // minute-floor, in seconds
  const dow = localDow(now, tzIana);
  const dateISO = localDateISO(now, tzIana);

  const state = req.state ?? undefined;
  const rule = state ? STATE_RULES[state] : undefined;
  const hols = state ? STATE_HOLIDAYS[state] : undefined;

  // Step 3: holiday + dow blackout
  if (rule && hols?.has(dateISO)) {
    const nextOpen = new Date(nextDayOpenMs(now, tzIana, FED_FLOOR.openLocal, state, hols));
    return {
      outcome: 'SKIP_UNTIL',
      tzIana,
      confidence,
      nextOpen,
      reason: REASONS.STATE_HOLIDAY_BLACKOUT,
      ruleApplied: `${state}_holiday`,
    };
  }

  const dowWindow = rule?.perDow?.[dow];
  if (rule && dowWindow && isBlackout(dowWindow)) {
    const nextOpen = new Date(nextDayOpenMs(now, tzIana, FED_FLOOR.openLocal, state, hols));
    return {
      outcome: 'SKIP_UNTIL',
      tzIana,
      confidence,
      nextOpen,
      reason: dow === 0 ? REASONS.STATE_SUNDAY_BLACKOUT : REASONS.STATE_DOW_BLACKOUT,
      ruleApplied: `${state}_${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]}_blackout`,
    };
  }

  // Step 4: build effective window
  let eff: Window = { ...FED_FLOOR };

  if (rule && dowWindow && !isBlackout(dowWindow) && (dowWindow.openLocal !== 0 || dowWindow.closeLocal !== 0)) {
    eff = intersect(eff, dowWindow);
  }

  if (req.isAutoDialer && rule) {
    const blackoutDows = rule.autoDialerBlackoutDows ?? 0;
    if (blackoutDows !== 0 && (blackoutDows >> dow) & 1) {
      const nextOpen = new Date(nextDayOpenMs(now, tzIana, rule.autoDialerOnly?.openLocal ?? FED_FLOOR.openLocal, state, hols));
      return {
        outcome: 'SKIP_UNTIL',
        tzIana,
        confidence,
        nextOpen,
        reason: REASONS.STATE_AUTODIALER_WINDOW,
        ruleApplied: `${state}_${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]}_autodialer_blackout`,
      };
    }
    if (rule.autoDialerOnly) {
      eff = intersect(eff, rule.autoDialerOnly);
    }
  }

  if (req.campaignWindow && (req.campaignWindow.openLocal !== 0 || req.campaignWindow.closeLocal !== 0)) {
    eff = intersect(eff, req.campaignWindow);
  }

  if (isBlackout(eff)) {
    const nextOpen = new Date(nextDayOpenMs(now, tzIana, FED_FLOOR.openLocal, state, hols));
    return {
      outcome: 'SKIP_UNTIL',
      tzIana,
      confidence,
      nextOpen,
      reason: req.isAutoDialer ? REASONS.STATE_AUTODIALER_WINDOW : REASONS.AFTER_WINDOW,
      ruleApplied: ruleNameOf(state, dow, eff),
      effective: eff,
    };
  }

  // Step 5: in-window check (minute precision)
  if (partyMins < eff.openLocal) {
    const midnightMs = localMidnightUtcMs(now, tzIana);
    const nextOpen = new Date(midnightMs + eff.openLocal * 1000);
    return {
      outcome: 'SKIP_UNTIL',
      tzIana,
      confidence,
      nextOpen,
      reason: REASONS.BEFORE_WINDOW,
      ruleApplied: ruleNameOf(state, dow, eff),
      effective: eff,
    };
  }

  if (partyMins >= eff.closeLocal) {
    const nextOpen = new Date(nextDayOpenMs(now, tzIana, eff.openLocal, state, hols));
    return {
      outcome: 'SKIP_UNTIL',
      tzIana,
      confidence,
      nextOpen,
      reason: REASONS.AFTER_WINDOW,
      ruleApplied: ruleNameOf(state, dow, eff),
      effective: eff,
    };
  }

  // Step 6: originate boundary check (30s, second precision)
  if (req.enforcementPoint === 'originate_path') {
    const timeToClose = eff.closeLocal - partyElapsed;
    if (timeToClose < 30) {
      const nextOpen = new Date(nextDayOpenMs(now, tzIana, eff.openLocal, state, hols));
      return {
        outcome: 'SKIP_UNTIL',
        tzIana,
        confidence,
        nextOpen,
        reason: REASONS.BOUNDARY_30S_TO_CLOSE,
        ruleApplied: ruleNameOf(state, dow, eff),
        effective: eff,
      };
    }
  }

  return {
    outcome: 'ALLOW',
    tzIana,
    confidence,
    reason: REASONS.OK,
    ruleApplied: ruleNameOf(state, dow, eff),
    effective: eff,
  };
}

/**
 * assertCallWindowOrThrow is a legacy adapter for callers that prefer throw semantics.
 * Throws an Error with code 'OUTSIDE_CALL_WINDOW' on non-ALLOW outcomes.
 */
export async function assertCallWindowOrThrow(req: CheckRequest): Promise<void> {
  const res = await check(req);
  if (res.outcome !== 'ALLOW') {
    const err = new Error(`Outside call window: ${res.reason}`) as Error & {
      code: string;
      reason: string;
      nextOpen: Date | undefined;
      tzIana: string | undefined;
      ruleApplied: string;
    };
    err.code = 'OUTSIDE_CALL_WINDOW';
    err.reason = res.reason;
    err.nextOpen = res.nextOpen;
    err.tzIana = res.tzIana;
    err.ruleApplied = res.ruleApplied;
    throw err;
  }
}

function ruleNameOf(state: string | undefined, dow: number, eff: Window): string {
  const s = state ?? 'FED';
  const d = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow] ?? '?';
  const o = Math.floor(eff.openLocal / 3600);
  const c = Math.floor(eff.closeLocal / 3600);
  return `${s}_${d}_${o}_${c}`;
}
