// N05 — Hiya branded calling client.
// Auth: API key in X-API-Key header.
// Reputation: 0–10 scale → normalized to 0–100.

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

const BASE_URL = 'https://api.connect.hiya.com/v1';

export class HiyaClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'hiya';

  constructor(private readonly cfg: { apiKey: string }) {}

  private get headers(): Record<string, string> {
    return {
      'X-API-Key': this.cfg.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const res = await fetch(`${BASE_URL}/business/profile`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        display_name: profile.brandName,
        logo_url: profile.logoUrl,
        industry: mapVertical(profile.vertical, 'hiya'),
        primary_use_case: profile.callReasons[0]
          ? mapCallReason(profile.callReasons[0], 'hiya')
          : 'NOTIFICATION',
        website: profile.website,
        description: '',
      }),
    });
    if (!res.ok) {
      throw new ProviderError('hiya', 'BRAND_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { business_id: string };
    return data.business_id;
  }

  async updateBrand(providerBrandId: string, profile: BrandProfile): Promise<void> {
    const res = await fetch(`${BASE_URL}/business/profile/${providerBrandId}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({
        display_name: profile.brandName,
        logo_url: profile.logoUrl,
        industry: mapVertical(profile.vertical, 'hiya'),
        primary_use_case: profile.callReasons[0]
          ? mapCallReason(profile.callReasons[0], 'hiya')
          : 'NOTIFICATION',
        website: profile.website,
      }),
    });
    if (!res.ok) {
      throw new ProviderError('hiya', 'BRAND_UPDATE_FAILED', res.status, await res.text());
    }
  }

  async getBrandStatus(providerBrandId: string): Promise<{ status: 'pending' | 'active' | 'rejected' | 'suspended'; syncedAt: Date }> {
    const res = await fetch(`${BASE_URL}/business/profile/${providerBrandId}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new ProviderError('hiya', 'BRAND_STATUS_FAILED', res.status);
    }
    const data = await res.json() as { status: string };
    const statusMap: Record<string, 'pending' | 'active' | 'rejected' | 'suspended'> = {
      ACTIVE:   'active',
      PENDING:  'pending',
      REJECTED: 'rejected',
      SUSPENDED: 'suspended',
      COOLING:  'pending',
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
    const res = await fetch(`${BASE_URL}/business/numbers`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        business_id: providerBrandId,
        numbers: requests.map(r => ({ e164: r.e164 })),
      }),
    });
    if (!res.ok) {
      throw new ProviderError('hiya', 'NUMBER_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { results: Array<{ e164: string; number_id?: string; status: string; error?: string }> };
    return data.results.map(item => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'ACTIVE' ? 'active' : 'pending',
      attestationLevel: null, // Hiya does not report attestation level
      error: item.error ?? null,
    }));
  }

  async deregisterNumber(_providerBrandId: string, e164: string): Promise<void> {
    const res = await fetch(
      `${BASE_URL}/business/numbers/${encodeURIComponent(e164)}`,
      { method: 'DELETE', headers: this.headers },
    );
    if (!res.ok && res.status !== 404) {
      throw new ProviderError('hiya', 'NUMBER_DEREG_FAILED', res.status);
    }
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const res = await fetch(
      `${BASE_URL}/business/numbers/${encodeURIComponent(e164)}/score`,
      { headers: this.headers },
    );
    if (!res.ok) {
      throw new ProviderError('hiya', 'REP_FETCH_FAILED', res.status);
    }
    const data = await res.json() as { score?: number; is_blocked?: boolean; spam_label?: string };
    const rawScore = data.score ?? 10;
    return {
      e164,
      normalizedScore: Math.round(Math.max(0, Math.min(100, rawScore * 10))), // Hiya: 0–10 → 0–100
      rawScore,
      isBlocked: data.is_blocked ?? false,
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  async submitDispute(e164: string, notes: string): Promise<void> {
    const res = await fetch(
      `${BASE_URL}/business/numbers/${encodeURIComponent(e164)}/dispute`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ notes }),
      },
    );
    if (!res.ok) {
      throw new ProviderError('hiya', 'DISPUTE_FAILED', res.status, await res.text());
    }
  }
}
