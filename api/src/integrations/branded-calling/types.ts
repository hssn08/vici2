// N05 — Branded Calling integration types.
// Shared by provider clients, workers, and admin routes.

export type ProviderKind = 'first_orion' | 'hiya' | 'tns';

export interface BrandProfile {
  brandName: string;       // display name, ≤30 chars
  logoUrl: string | null;
  vertical: string;        // canonical vici2 BrandVertical enum value
  callReasons: string[];   // array of canonical call reason strings
  website?: string;
  contactEmail?: string;
}

export interface DidRegistrationRequest {
  e164: string;
  callReason: string;     // canonical vici2 call reason
  effectiveDate: string;  // ISO date string YYYY-MM-DD
}

export interface DidRegistrationResult {
  e164: string;
  providerNumberId: string | null;
  status: 'active' | 'pending' | 'rejected';
  attestationLevel: 'A' | 'B' | 'C' | null;
  error: string | null;
}

export interface ReputationScore {
  e164: string;
  normalizedScore: number;  // 0–100; higher = better
  rawScore: number;
  isBlocked: boolean;
  spamLabel: string | null;
  polledAt: Date;
}

export interface IBrandedCallingProvider {
  kind: ProviderKind;

  // Brand lifecycle
  registerBrand(profile: BrandProfile): Promise<string>;   // returns provider_brand_id
  updateBrand(providerBrandId: string, profile: BrandProfile): Promise<void>;
  getBrandStatus(providerBrandId: string): Promise<{
    status: 'pending' | 'active' | 'rejected' | 'suspended';
    syncedAt: Date;
  }>;

  // DID registration
  registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]>;
  deregisterNumber(providerBrandId: string, e164: string): Promise<void>;

  // Reputation
  getReputation(e164: string): Promise<ReputationScore>;

  // Dispute
  submitDispute(e164: string, notes: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// X04 quarantine hook interface (consumed by workers/poll-reputation.ts)
// ---------------------------------------------------------------------------

export interface BrandedCallingReputationHook {
  onRepScoreUpdated(
    didId: bigint,
    tenantId: bigint,
    normalizedScore: number,
  ): Promise<void>;
}
