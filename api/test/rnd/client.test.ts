/**
 * api/test/rnd/client.test.ts
 *
 * N06 — Unit tests for the RND API client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RndMockClient,
  RndClientImpl,
  buildRndClient,
  RndRateLimitError,
  RndQuotaError,
  RndOutageError,
  RndAuthError,
  type RndRedisClient,
} from '../../src/integrations/rnd/client.js';

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function makeMockRedis(cachedToken: string | null = null): RndRedisClient {
  return {
    get: vi.fn().mockResolvedValue(cachedToken),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

// ---------------------------------------------------------------------------
// RndMockClient tests
// ---------------------------------------------------------------------------

describe('RndMockClient', () => {
  const client = new RndMockClient();

  it('returns "yes" for numbers ending in 0', async () => {
    const resp = await client.query([{ tn: '+12025551230', date: '2025-01-01' }]);
    expect(resp.results[0].result).toBe('yes');
    expect(resp.results[0].disconnect_date).toBe('2025-01-15');
  });

  it('returns "no_data" for numbers ending in 9', async () => {
    const resp = await client.query([{ tn: '+12025551239', date: '2025-01-01' }]);
    expect(resp.results[0].result).toBe('no_data');
    expect(resp.results[0].disconnect_date).toBeNull();
  });

  it('returns "no" for all other numbers', async () => {
    const resp = await client.query([{ tn: '+12025551235', date: '2025-01-01' }]);
    expect(resp.results[0].result).toBe('no');
  });

  it('handles empty input', async () => {
    const resp = await client.query([]);
    expect(resp.results).toHaveLength(0);
    expect(resp.query_count).toBe(0);
  });

  it('returns query_count matching input length', async () => {
    const items = [
      { tn: '+12025551231', date: '2025-01-01' },
      { tn: '+12025551232', date: '2025-01-01' },
      { tn: '+12025551233', date: '2025-01-01' },
    ];
    const resp = await client.query(items);
    expect(resp.query_count).toBe(3);
    expect(resp.results).toHaveLength(3);
  });

  it('validateCredentials resolves without error', async () => {
    await expect(client.validateCredentials()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRndClient factory
// ---------------------------------------------------------------------------

describe('buildRndClient', () => {
  it('returns MockClient in test environment', () => {
    const client = buildRndClient({
      tenantId: 1n,
      clientId: 'real-id',
      clientSecret: 'real-secret',
      redis: makeMockRedis(),
    });
    // In test env (NODE_ENV=test), always mock
    expect(client).toBeInstanceOf(RndMockClient);
  });

  it('returns MockClient when credentials are empty', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const client = buildRndClient({
      tenantId: 1n,
      clientId: '',
      clientSecret: '',
      redis: makeMockRedis(),
    });
    expect(client).toBeInstanceOf(RndMockClient);
    process.env.NODE_ENV = original;
  });
});

// ---------------------------------------------------------------------------
// RndClientImpl — token caching
// ---------------------------------------------------------------------------

describe('RndClientImpl token caching', () => {
  it('uses cached token when available', async () => {
    const redis = makeMockRedis('cached-token-123');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], query_count: 0, subscription_remaining: 0 }),
      headers: new Headers(),
    } as Response);

    const client = new RndClientImpl(1n, 'id', 'secret', redis, 'https://mock.test');
    await client.query([{ tn: '+12025551234', date: '2025-01-01' }]);

    expect(redis.get).toHaveBeenCalledWith('t:1:rnd:token');
    // fetch should be called once for the query, but NOT for token (cached)
    const tokenFetches = fetchSpy.mock.calls.filter((c) =>
      (c[0] as string).includes('/auth/token'),
    );
    expect(tokenFetches).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('fetches new token when cache is empty', async () => {
    const redis = makeMockRedis(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if ((url as string).includes('/auth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }),
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [], query_count: 0, subscription_remaining: 0 }),
        headers: new Headers(),
      } as Response;
    });

    const client = new RndClientImpl(1n, 'id', 'secret', redis, 'https://mock.test');
    await client.query([{ tn: '+12025551234', date: '2025-01-01' }]);

    expect(redis.set).toHaveBeenCalledWith('t:1:rnd:token', 'fresh-token', 'EX', 3540);
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// RndClientImpl — error handling
// ---------------------------------------------------------------------------

describe('RndClientImpl error handling', () => {
  let redis: RndRedisClient;
  let client: RndClientImpl;

  beforeEach(() => {
    redis = makeMockRedis('token-xyz');
    client = new RndClientImpl(1n, 'id', 'secret', redis, 'https://mock.test');
  });

  it('throws RndRateLimitError on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '45' }),
      json: async () => ({}),
    } as Response);

    await expect(client.query([{ tn: '+12025551234', date: '2025-01-01' }]))
      .rejects.toThrow(RndRateLimitError);

    const err = await client.query([{ tn: '+12025551234', date: '2025-01-01' }])
      .catch((e) => e);
    if (err instanceof RndRateLimitError) {
      expect(err.retryAfterSeconds).toBe(45);
    }
  });

  it('throws RndQuotaError on 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 402,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);

    await expect(client.query([{ tn: '+12025551234', date: '2025-01-01' }]))
      .rejects.toThrow(RndQuotaError);
  });

  it('throws RndOutageError on 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);

    await expect(client.query([{ tn: '+12025551234', date: '2025-01-01' }]))
      .rejects.toThrow(RndOutageError);
  });

  it('throws RndAuthError on 401 during token fetch', async () => {
    const noTokenRedis = makeMockRedis(null);
    const authClient = new RndClientImpl(1n, 'id', 'bad-secret', noTokenRedis, 'https://mock.test');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);

    await expect(authClient.query([{ tn: '+12025551234', date: '2025-01-01' }]))
      .rejects.toThrow(RndAuthError);
  });

  it('rejects batches larger than 1000', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({
      tn: `+1202555${String(i).padStart(4, '0')}`,
      date: '2025-01-01',
    }));
    await expect(client.query(items)).rejects.toThrow(/Max 1,000/);
  });
});
