// N05 — First Orion branded calling client.
// Auth: OAuth2 client_credentials; token cached in-process until expiry.

import type {
  IBrandedCallingProvider,
  BrandProfile,
  DidRegistrationRequest,
  DidRegistrationResult,
  ReputationScore,
  ProviderKind,
} from './types.js';
import { ProviderError } from './errors.js';
import { mapVertical } from './vertical-map.js';
import { mapCallReason } from './call-reason-map.js';

const AUTH_URL = 'https://auth.firstorion.com/oauth/token';
const BASE_URL = 'https://api.firstorion.com/engage/v2';

interface TokenCache {
  token: string;
  expiresAt: Date;
}

export class FirstOrionClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'first_orion';
  private tokenCache: TokenCache | null = null;

  constructor(private readonly cfg: { clientId: string; clientSecret: string }) {}

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > new Date()) {
      return this.tokenCache.token;
    }
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new ProviderError('first_orion', 'TOKEN_FETCH_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { access_token: string; expires_in: number };
    this.tokenCache = {
      token: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
    };
    return this.tokenCache.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const headers = await this.authHeaders();
    const res = await fetch(`${BASE_URL}/brands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        brand_name: profile.brandName,
        logo_url: profile.logoUrl,
        vertical: mapVertical(profile.vertical, 'first_orion'),
        call_reasons: profile.callReasons.map(cr => mapCallReason(cr, 'first_orion')),
        primary_contact_email: profile.contactEmail,
        attestation_level: 'A',
      }),
    });
    if (!res.ok) {
      throw new ProviderError('first_orion', 'BRAND_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { brand_id: string };
    return data.brand_id;
  }

  async updateBrand(providerBrandId: string, profile: BrandProfile): Promise<void> {
    const headers = await this.authHeaders();
    const res = await fetch(`${BASE_URL}/brands/${providerBrandId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        brand_name: profile.brandName,
        logo_url: profile.logoUrl,
        vertical: mapVertical(profile.vertical, 'first_orion'),
        call_reasons: profile.callReasons.map(cr => mapCallReason(cr, 'first_orion')),
        primary_contact_email: profile.contactEmail,
      }),
    });
    if (!res.ok) {
      throw new ProviderError('first_orion', 'BRAND_UPDATE_FAILED', res.status, await res.text());
    }
  }

  async getBrandStatus(providerBrandId: string): Promise<{ status: 'pending' | 'active' | 'rejected' | 'suspended'; syncedAt: Date }> {
    const headers = await this.authHeaders();
    const res = await fetch(`${BASE_URL}/brands/${providerBrandId}`, { headers });
    if (!res.ok) {
      throw new ProviderError('first_orion', 'BRAND_STATUS_FAILED', res.status);
    }
    const data = await res.json() as { status: string };
    const statusMap: Record<string, 'pending' | 'active' | 'rejected' | 'suspended'> = {
      PENDING:   'pending',
      ACTIVE:    'active',
      REJECTED:  'rejected',
      SUSPENDED: 'suspended',
    };
    return {
      status: statusMap[data.status] ?? 'pending',
      syncedAt: new Date(),
    };
  }

  async registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]> {
    const headers = await this.authHeaders();
    const res = await fetch(`${BASE_URL}/brands/${providerBrandId}/numbers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        numbers: requests.map(r => ({
          e164: r.e164,
          call_reason: mapCallReason(r.callReason, 'first_orion'),
          effective_date: r.effectiveDate,
        })),
      }),
    });
    if (!res.ok) {
      throw new ProviderError('first_orion', 'NUMBER_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { results: Array<{ e164: string; number_id?: string; status: string; attestation_level?: string; error_message?: string }> };
    return data.results.map(item => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'ACTIVE' ? 'active' : item.status === 'PENDING' ? 'pending' : 'rejected',
      attestationLevel: (item.attestation_level as 'A' | 'B' | 'C' | undefined) ?? null,
      error: item.error_message ?? null,
    }));
  }

  async deregisterNumber(providerBrandId: string, e164: string): Promise<void> {
    const headers = await this.authHeaders();
    const res = await fetch(
      `${BASE_URL}/brands/${providerBrandId}/numbers/${encodeURIComponent(e164)}`,
      { method: 'DELETE', headers },
    );
    if (!res.ok && res.status !== 404) {
      throw new ProviderError('first_orion', 'NUMBER_DEREG_FAILED', res.status);
    }
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const headers = await this.authHeaders();
    const res = await fetch(
      `${BASE_URL}/numbers/${encodeURIComponent(e164)}/reputation`,
      { headers },
    );
    if (!res.ok) {
      throw new ProviderError('first_orion', 'REP_FETCH_FAILED', res.status);
    }
    const data = await res.json() as { reputation_score: number; is_blocked?: boolean; spam_label?: string };
    return {
      e164,
      normalizedScore: Math.round(Math.max(0, Math.min(100, data.reputation_score))),
      rawScore: data.reputation_score,
      isBlocked: data.is_blocked ?? false,
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  async submitDispute(e164: string, notes: string): Promise<void> {
    const headers = await this.authHeaders();
    const res = await fetch(
      `${BASE_URL}/numbers/${encodeURIComponent(e164)}/dispute`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ notes }),
      },
    );
    if (!res.ok) {
      throw new ProviderError('first_orion', 'DISPUTE_FAILED', res.status, await res.text());
    }
  }

  /** Invalidate token cache (used after credential rotation). */
  clearTokenCache(): void {
    this.tokenCache = null;
  }
}
