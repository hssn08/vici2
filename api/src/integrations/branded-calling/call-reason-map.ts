// N05 — Canonical call reason → provider vocabulary mappings.

export type ProviderKind = 'first_orion' | 'hiya' | 'tns';

// First Orion uses same vocabulary as vici2 canonical.
const FIRST_ORION_CALL_REASON: Record<string, string> = {};

// Hiya renames a few.
const HIYA_CALL_REASON: Record<string, string> = {
  DELIVERY_NOTIFICATION: 'DELIVERY',
  GENERAL_NOTIFICATION:  'NOTIFICATION',
};

// TNS renames a few.
const TNS_CALL_REASON: Record<string, string> = {
  COLLECTIONS:          'DEBT_COLLECTION',
  FRAUD_ALERT:          'SECURITY_ALERT',
  GENERAL_NOTIFICATION: 'GENERAL',
};

export function mapCallReason(canonical: string, provider: ProviderKind): string {
  switch (provider) {
    case 'first_orion': return FIRST_ORION_CALL_REASON[canonical] ?? canonical;
    case 'hiya':        return HIYA_CALL_REASON[canonical] ?? canonical;
    case 'tns':         return TNS_CALL_REASON[canonical] ?? canonical;
  }
}
