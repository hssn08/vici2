// N05 — Canonical BrandVertical → provider vocabulary mappings.

export type ProviderKind = 'first_orion' | 'hiya' | 'tns';

// First Orion uses the same vocabulary as vici2 canonical.
const FIRST_ORION_VERTICAL: Record<string, string> = {};

// Hiya has a few renames.
const HIYA_VERTICAL: Record<string, string> = {
  TELEMARKETING: 'MARKETING',
  NON_PROFIT:    'NON_PROFIT',
};

// TNS uses same vocabulary as vici2 canonical.
const TNS_VERTICAL: Record<string, string> = {};

export function mapVertical(canonical: string, provider: ProviderKind): string {
  switch (provider) {
    case 'first_orion': return FIRST_ORION_VERTICAL[canonical] ?? canonical;
    case 'hiya':        return HIYA_VERTICAL[canonical] ?? canonical;
    case 'tns':         return TNS_VERTICAL[canonical] ?? canonical;
  }
}
