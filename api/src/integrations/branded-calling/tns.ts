// N05 — TNS (Transaction Network Services) branded calling client.
// Auth: HMAC-SHA256 signed requests (X-TNS-Key + X-TNS-Timestamp + X-TNS-Signature).
// Reputation: overall_risk_score 0–100 where 0=lowest risk; inverted for normalized scale.

import { createHmac } from 'node:crypto';
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

const BASE_URL = 'https://ecid-api.tnsi.com/v3';

export class TnsClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'tns';

  constructor(private readonly cfg: { apiKey: string; apiSecret: string }) {}

  private sign(method: string, path: string, timestamp: string, bodyHash: string): string {
    const message = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
    return createHmac('sha256', this.cfg.apiSecret).update(message).digest('hex');
  }

  private async request(method: string, path: string, body?: object): Promise<Response> {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyHash = createHmac('sha256', this.cfg.apiSecret).update(bodyStr).digest('hex');
    const sig = this.sign(method.toUpperCase(), path, timestamp, bodyHash);

    return fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'X-TNS-Key':       this.cfg.apiKey,
        'X-TNS-Timestamp': timestamp,
        'X-TNS-Signature': sig,
        'Content-Type':    'application/json',
      },
      body: bodyStr || undefined,
    });
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const res = await this.request('POST', '/brands', {
      company_name:   profile.brandName,
      display_name:   profile.brandName,
      vertical:       mapVertical(profile.vertical, 'tns'),
      logo_url:       profile.logoUrl,
      call_reasons:   profile.callReasons.map(cr => mapCallReason(cr, 'tns')),
      website:        profile.website,
      contact_email:  profile.contactEmail,
      attestation:    'A',
    });
    if (!res.ok) {
      throw new ProviderError('tns', 'BRAND_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as { brand_id: string };
    return data.brand_id;
  }

  async updateBrand(providerBrandId: string, profile: BrandProfile): Promise<void> {
    const res = await this.request('PATCH', `/brands/${providerBrandId}`, {
      display_name:  profile.brandName,
      logo_url:      profile.logoUrl,
      vertical:      mapVertical(profile.vertical, 'tns'),
      call_reasons:  profile.callReasons.map(cr => mapCallReason(cr, 'tns')),
      website:       profile.website,
      contact_email: profile.contactEmail,
    });
    if (!res.ok) {
      throw new ProviderError('tns', 'BRAND_UPDATE_FAILED', res.status, await res.text());
    }
  }

  async getBrandStatus(providerBrandId: string): Promise<{ status: 'pending' | 'active' | 'rejected' | 'suspended'; syncedAt: Date }> {
    const res = await this.request('GET', `/brands/${providerBrandId}`);
    if (!res.ok) {
      throw new ProviderError('tns', 'BRAND_STATUS_FAILED', res.status);
    }
    const data = await res.json() as { status: string };
    const statusMap: Record<string, 'pending' | 'active' | 'rejected' | 'suspended'> = {
      APPROVED:  'active',
      PENDING:   'pending',
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
    const res = await this.request('POST', `/brands/${providerBrandId}/numbers`, {
      numbers: requests.map(r => ({
        e164:           r.e164,
        call_reason:    mapCallReason(r.callReason, 'tns'),
        effective_date: r.effectiveDate,
      })),
    });
    if (!res.ok) {
      throw new ProviderError('tns', 'NUMBER_REG_FAILED', res.status, await res.text());
    }
    const data = await res.json() as {
      results: Array<{
        e164: string;
        number_id?: string;
        status: string;
        attestation_confirmed?: string;
        error_message?: string;
      }>
    };
    return data.results.map(item => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'APPROVED' ? 'active' : item.status === 'PENDING' ? 'pending' : 'rejected',
      attestationLevel: (item.attestation_confirmed as 'A' | 'B' | 'C' | undefined) ?? null,
      error: item.error_message ?? null,
    }));
  }

  async deregisterNumber(providerBrandId: string, e164: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/brands/${providerBrandId}/numbers/${encodeURIComponent(e164)}`,
    );
    if (!res.ok && res.status !== 404) {
      throw new ProviderError('tns', 'NUMBER_DEREG_FAILED', res.status);
    }
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const res = await this.request('GET', `/numbers/${encodeURIComponent(e164)}/analytics`);
    if (!res.ok) {
      throw new ProviderError('tns', 'REP_FETCH_FAILED', res.status);
    }
    const data = await res.json() as {
      overall_risk_score?: number;
      user_block_rate_30d?: number;
      spam_label?: string;
    };
    // TNS: overall_risk_score 0–100 where 0=lowest risk; invert for normalized scale
    const rawScore = data.overall_risk_score ?? 0;
    const normalized = Math.round(100 - rawScore);
    return {
      e164,
      normalizedScore: Math.max(0, Math.min(100, normalized)),
      rawScore,
      isBlocked: (data.user_block_rate_30d ?? 0) > 0.15, // >15% block rate = effectively blocked
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  async submitDispute(e164: string, notes: string): Promise<void> {
    const res = await this.request('POST', `/numbers/${encodeURIComponent(e164)}/dispute`, { notes });
    if (!res.ok) {
      throw new ProviderError('tns', 'DISPUTE_FAILED', res.status, await res.text());
    }
  }

  /**
   * Compute the HMAC signature for a test vector.
   * Used in unit tests to verify the signing algorithm is correct.
   */
  signForTest(method: string, path: string, timestamp: string, bodyHash: string): string {
    return this.sign(method, path, timestamp, bodyHash);
  }
}
