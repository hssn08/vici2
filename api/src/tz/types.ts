// D03 TypeScript mirror types — frozen public interface.
// These are consumed by C01, D02, E01, T04, A04.

/** Seven confidence levels for timezone resolution. Frozen — no changes without RFC. */
export type Confidence =
  | 'KNOWN'           // lead.known_timezone (highest)
  | 'ZIP'             // ZIP centroid → IANA
  | 'NXX'             // NPA+NXX phone_codes hit
  | 'NPA'             // NPA-only fallback
  | 'STATE_DEFAULT'   // single-tz state (excludes 8 split states)
  | 'CAMPAIGN_DEFAULT'// admin-set campaign default
  | 'NONE';           // unresolvable; caller decides

export type NumberType =
  | 'UNKNOWN'
  | 'FIXED_LINE'
  | 'MOBILE'
  | 'FIXED_OR_MOBILE'
  | 'TOLL_FREE'
  | 'PREMIUM_RATE'
  | 'VOIP';

export interface ResolveRequest {
  leadId?: bigint;
  phoneE164: string;
  knownTimezone?: string;
  zip?: string;
  state?: string;
  campaignId?: string;
}

export interface ResolveResult {
  iana: string;           // '' if NONE
  confidence: Confidence;
  source: string;
  npa?: string;
  nxx?: string;
  numberType?: NumberType;
}

/** In-memory cache entry shape */
export interface CacheEntry {
  iana: string;
}
