/**
 * D03 timezone resolver shared types.
 * Frozen public interface — changes require an RFC.
 * Consumed by C01, D02, E01, T04, A04.
 */

/** Seven confidence levels for timezone resolution. */
export type Confidence =
  | 'KNOWN'            // lead.known_timezone (highest)
  | 'ZIP'              // ZIP centroid → IANA
  | 'NXX'             // NPA+NXX phone_codes hit
  | 'NPA'             // NPA-only fallback
  | 'STATE_DEFAULT'    // single-tz state (excludes 8 split states: IN KY TN FL ID OR ND SD NE)
  | 'CAMPAIGN_DEFAULT' // admin-set campaign default
  | 'NONE';            // unresolvable; caller (C01) decides BLOCK vs ALLOW_WARN

/** Phone number line type (informational; D03 reports, C01 decides). */
export type NumberType =
  | 'UNKNOWN'
  | 'FIXED_LINE'
  | 'MOBILE'
  | 'FIXED_OR_MOBILE'
  | 'TOLL_FREE'
  | 'PREMIUM_RATE'
  | 'VOIP';

/** Input to resolveTimezone / Resolve. */
export interface ResolveRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string; // IANA override; highest priority if valid
  zip?: string;           // 5-digit or XXXXX-XXXX US ZIP
  state?: string;         // 2-char US state code
  campaignId?: string;    // for Tier 6 campaign default
}

/** Output of resolveTimezone / Resolve. */
export interface ResolveResult {
  iana: string;           // "" if NONE
  confidence: Confidence;
  source: string;         // "lead.known_timezone" | "zip:90210" | "nxx:317-555" | ...
  npa?: string;
  nxx?: string;
  numberType?: NumberType; // informational; C01 may use MOBILE for warn_on_mobile_zip
}
