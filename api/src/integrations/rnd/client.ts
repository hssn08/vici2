/**
 * api/src/integrations/rnd/client.ts
 *
 * N06 — FCC Reassigned Numbers Database REST client.
 *
 * Features:
 * - OAuth 2.0 client credentials (token cached in Valkey)
 * - Up to 1,000 numbers per query
 * - Rate-limit aware (429 → respect Retry-After)
 * - Mock fallback when RND_MOCK=true or credentials absent (dev/test offline)
 */

import {
  RndAuthError,
  RndRateLimitError,
  RndQuotaError,
  RndOutageError,
  RndApiError,
  RndCredentialInvalidError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RndQueryItem {
  tn: string;    // E.164, e.g. +12025551234
  date: string;  // YYYY-MM-DD (consent/as-of date)
}

export interface RndResultItem {
  tn: string;
  result: 'yes' | 'no' | 'no_data';
  disconnect_date: string | null;  // YYYY-MM-DD or null
  queried_at: string;              // ISO 8601
}

export interface RndBatchResponse {
  results: RndResultItem[];
  query_count: number;
  subscription_remaining: number;
}

export interface RndSubscriptionStatus {
  tier: string;
  monthly_cap: number;
  queries_this_month: number;
  remaining: number;
  overage_queries: number;
}

/** Minimal Redis interface needed by the client for token caching. */
export interface RndRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
}

export interface RndClient {
  query(items: RndQueryItem[]): Promise<RndBatchResponse>;
  getSubscriptionStatus(): Promise<RndSubscriptionStatus>;
  validateCredentials(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

export class RndClientImpl implements RndClient {
  private readonly tokenKey: string;
  private readonly baseUrl: string;

  constructor(
    private readonly tenantId: bigint | number,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redis: RndRedisClient,
    baseUrl?: string,
  ) {
    this.tokenKey = `t:${tenantId}:rnd:token`;
    this.baseUrl = baseUrl ?? process.env.RND_API_BASE_URL ?? 'https://api.reassigned.us';
  }

  async getToken(): Promise<string> {
    const cached = await this.redis.get(this.tokenKey);
    if (cached) return cached;

    const res = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'rnd.query',
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new RndAuthError(`RND token fetch failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new RndApiError(`RND token fetch error: ${res.status}`, res.status);
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    const ttl = Math.max((body.expires_in ?? 3600) - 60, 60);
    await this.redis.set(this.tokenKey, body.access_token, 'EX', ttl);
    return body.access_token;
  }

  async query(items: RndQueryItem[]): Promise<RndBatchResponse> {
    if (items.length === 0) {
      return { results: [], query_count: 0, subscription_remaining: 0 };
    }
    if (items.length > 1000) {
      throw new RndApiError('Max 1,000 items per query batch');
    }

    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ numbers: items }),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RndRateLimitError(
        `RND rate limited. Retry after ${retryAfter}s`,
        retryAfter,
      );
    }
    if (res.status === 402) {
      throw new RndQuotaError('RND subscription quota exceeded');
    }
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      throw new RndOutageError(`RND service unavailable (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new RndApiError(`RND API error: ${res.status}`, res.status);
    }

    return res.json() as Promise<RndBatchResponse>;
  }

  async getSubscriptionStatus(): Promise<RndSubscriptionStatus> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/v1/subscription`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new RndApiError(`RND subscription status error: ${res.status}`, res.status);
    }
    return res.json() as Promise<RndSubscriptionStatus>;
  }

  /** Attempt a token fetch to validate credentials. Throws RndCredentialInvalidError on failure. */
  async validateCredentials(): Promise<void> {
    try {
      // Force a fresh token fetch (bypass cache)
      const res = await fetch(`${this.baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: 'rnd.query',
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new RndCredentialInvalidError('RND credentials are invalid');
      }
      if (!res.ok) {
        throw new RndApiError(`RND validation error: ${res.status}`, res.status);
      }
    } catch (err) {
      if (err instanceof RndCredentialInvalidError) throw err;
      // Network errors or outage — wrap as credential invalid for the UI
      throw new RndCredentialInvalidError(
        `RND credential validation failed: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mock implementation (dev/test offline mode)
// ---------------------------------------------------------------------------

export class RndMockClient implements RndClient {
  /**
   * Deterministic mock: numbers ending in 0 → 'yes' (reassigned),
   * numbers ending in 9 → 'no_data', all others → 'no'.
   */
  async query(items: RndQueryItem[]): Promise<RndBatchResponse> {
    const now = new Date().toISOString();
    const results: RndResultItem[] = items.map((item) => {
      const lastDigit = item.tn.at(-1);
      if (lastDigit === '0') {
        return {
          tn: item.tn,
          result: 'yes',
          disconnect_date: '2025-01-15',
          queried_at: now,
        };
      } else if (lastDigit === '9') {
        return {
          tn: item.tn,
          result: 'no_data',
          disconnect_date: null,
          queried_at: now,
        };
      } else {
        return {
          tn: item.tn,
          result: 'no',
          disconnect_date: null,
          queried_at: now,
        };
      }
    });
    return {
      results,
      query_count: items.length,
      subscription_remaining: 999_999,
    };
  }

  async getSubscriptionStatus(): Promise<RndSubscriptionStatus> {
    return {
      tier: 'mock',
      monthly_cap: 1_000_000,
      queries_this_month: 0,
      remaining: 1_000_000,
      overage_queries: 0,
    };
  }

  async validateCredentials(): Promise<void> {
    // Mock always passes
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildRndClient(params: {
  tenantId: bigint | number;
  clientId: string;
  clientSecret: string;
  redis: RndRedisClient;
  baseUrl?: string;
}): RndClient {
  // Mock mode: no real credentials or env flag set
  const useMock =
    process.env.RND_MOCK === 'true' ||
    !params.clientId ||
    !params.clientSecret ||
    process.env.NODE_ENV === 'test';

  if (useMock) return new RndMockClient();

  return new RndClientImpl(
    params.tenantId,
    params.clientId,
    params.clientSecret,
    params.redis,
    params.baseUrl,
  );
}

export {
  RndAuthError,
  RndRateLimitError,
  RndQuotaError,
  RndOutageError,
  RndApiError,
  RndCredentialInvalidError,
};
