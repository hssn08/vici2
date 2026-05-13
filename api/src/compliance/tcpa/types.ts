/**
 * C01 TCPA time-window gate — TypeScript mirror of the Go canonical.
 * DO NOT define separate rule logic here; all rules come from rules.gen.ts.
 */

export type Outcome = 'ALLOW' | 'SKIP_UNTIL' | 'BLOCK_INVALID';

export type EnforcementPoint =
  | 'hopper_filler'
  | 'originate_path'
  | 'pacing'
  | 'manual_dial';

export type UnknownTzPolicy = 'deny' | 'warn_pass';

export type Confidence =
  | 'KNOWN'
  | 'ZIP'
  | 'NXX'
  | 'NPA'
  | 'STATE_DEFAULT'
  | 'CAMPAIGN_DEFAULT'
  | 'NONE';

/**
 * Window defines a callable time range for a single day (local time).
 * openLocal and closeLocal are seconds-since-local-midnight.
 */
export interface Window {
  openLocal: number;  // seconds since midnight (inclusive)
  closeLocal: number; // seconds since midnight (exclusive)
  dowMask?: number;   // bit 0=Sun … bit 6=Sat; 0 or undefined = all days
}

export interface CheckRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string; // IANA tz name
  zip?: string;
  state?: string;         // 2-char US state code
  campaignId?: bigint;
  campaignWindow?: Window;
  unknownTzPolicy?: UnknownTzPolicy;
  enforcementPoint: EnforcementPoint;
  when?: Date;            // defaults to new Date()
  isAutoDialer?: boolean;
}

export interface CheckResult {
  outcome: Outcome;
  tzIana?: string;
  confidence: Confidence;
  nextOpen?: Date;
  reason: string;
  ruleApplied: string;
  partyLocal?: Date;
  effective?: Window;
}

/**
 * All valid reason strings (controlled vocabulary, mirrors Go reasons.go).
 */
export const REASONS = {
  NO_TIMEZONE: 'no_timezone',
  UNKNOWN_TZ_WARN_PASS: 'unknown_tz_warn_pass',
  STATE_SUNDAY_BLACKOUT: 'state_sunday_blackout',
  STATE_DOW_BLACKOUT: 'state_dow_blackout',
  STATE_HOLIDAY_BLACKOUT: 'state_holiday_blackout',
  BEFORE_WINDOW: 'before_window',
  AFTER_WINDOW: 'after_window',
  STATE_AUTODIALER_WINDOW: 'state_autodialer_window',
  BOUNDARY_30S_TO_CLOSE: 'boundary_30s_to_close',
  OK: 'ok',
} as const;

export type Reason = (typeof REASONS)[keyof typeof REASONS];
