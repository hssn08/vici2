// N04 — Disposition → HubSpot hs_call_status mapping
// Default table per RESEARCH.md §4.2. Overridden by dispositionMap JSON
// stored in hubspot_integrations.

export const DEFAULT_DISPOSITION_MAP: Record<string, string> = {
  SALE:    'COMPLETED',
  NI:      'COMPLETED',
  NA:      'NO_ANSWER',
  B:       'BUSY',
  AM:      'VOICEMAIL_LEFT',
  CALLBK:  'COMPLETED',
  DNC:     'COMPLETED',
  XFER:    'COMPLETED',
};

const VALID_HS_STATUSES = new Set([
  'COMPLETED',
  'CONNECTED',
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'CANCELED',
  'VOICEMAIL_LEFT',
  'CALLING_CRM_USER',
  'MISSED',
  'RINGING',
  'IN_PROGRESS',
]);

/**
 * Resolve a vici2 disposition code to a HubSpot hs_call_status value.
 * @param disposition  vici2 dispo code (e.g. 'SALE', 'NA')
 * @param overrideMap  tenant-configured dispositionMap JSON (keys override defaults)
 */
export function resolveCallStatus(
  disposition: string,
  overrideMap: Record<string, string> = {},
): string {
  const override = overrideMap[disposition];
  if (override && VALID_HS_STATUSES.has(override)) return override;
  const def = DEFAULT_DISPOSITION_MAP[disposition];
  if (def) return def;
  return 'COMPLETED'; // safe fallback
}
