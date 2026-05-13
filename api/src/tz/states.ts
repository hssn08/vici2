/**
 * singleTzStateMap: maps 2-char US state/territory codes to canonical IANA timezone.
 * Only single-timezone states are included.
 *
 * The 8 split states are intentionally EXCLUDED:
 *   IN, KY, TN, FL, ID, OR, ND, SD, NE
 *
 * Leads in those states fall through to Tier 6 (campaign default) or NONE.
 * Using a single-state default for them is legally indefensible.
 */
export const singleTzStateMap: Record<string, string> = {
  // Eastern (UTC-5/UTC-4 DST)
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  GA: 'America/New_York',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/New_York',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NY: 'America/New_York',
  NC: 'America/New_York',
  OH: 'America/New_York',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WV: 'America/New_York',

  // Central (UTC-6/UTC-5 DST)
  AL: 'America/Chicago',
  AR: 'America/Chicago',
  IA: 'America/Chicago',
  IL: 'America/Chicago',
  KS: 'America/Chicago',
  LA: 'America/Chicago',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  OK: 'America/Chicago',
  TX: 'America/Chicago',
  WI: 'America/Chicago',

  // Mountain (UTC-7/UTC-6 DST)
  CO: 'America/Denver',
  MT: 'America/Denver',
  NM: 'America/Denver',
  UT: 'America/Denver',
  WY: 'America/Denver',

  // Arizona — no DST
  AZ: 'America/Phoenix',

  // Pacific (UTC-8/UTC-7 DST)
  CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',

  // Alaska
  AK: 'America/Anchorage',

  // Hawaii — no DST
  HI: 'Pacific/Honolulu',

  // Territories
  PR: 'America/Puerto_Rico',
  VI: 'America/Puerto_Rico',
  GU: 'Pacific/Guam',
  MP: 'Pacific/Guam',
  AS: 'Pacific/Pago_Pago',
};

/** The 8 split states excluded from Tier 5 (singleTzStateMap). */
export const splitStates = new Set<string>([
  'IN', 'KY', 'TN', 'FL', 'ID', 'OR', 'ND', 'SD', 'NE',
]);
