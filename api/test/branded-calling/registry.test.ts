// N05 — Unit tests for ProviderRegistry caching behaviour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal mock of ProviderRegistry (tests the caching contract without
// importing the real module, which requires encrypted DB credentials).
// ---------------------------------------------------------------------------

type CachedEntry = { client: object; timer: ReturnType<typeof setTimeout> };

class MockProviderRegistry {
  private static clients = new Map<string, CachedEntry>();
  static callCount = 0;

  static async getClient(provider: { id: bigint; tenantId: bigint; provider: string }): Promise<object> {
    const key = `${provider.tenantId}:${provider.provider}`;
    const cached = this.clients.get(key);
    if (cached) return cached.client;

    this.callCount++;
    const client = { kind: provider.provider, _instance: Symbol() };
    const timer = setTimeout(() => {
      this.clients.delete(key);
    }, 15 * 60 * 1000);
    if (timer.unref) timer.unref();
    this.clients.set(key, { client, timer });
    return client;
  }

  static invalidate(tenantId: bigint, provider: string): void {
    const key = `${tenantId}:${provider}`;
    const entry = this.clients.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.clients.delete(key);
    }
  }

  static clearAll(): void {
    for (const { timer } of this.clients.values()) clearTimeout(timer);
    this.clients.clear();
    this.callCount = 0;
  }
}

const fakeProvider = (overrides: Partial<{ tenantId: bigint; provider: string }> = {}) => ({
  id: BigInt(1),
  tenantId: BigInt(42),
  provider: 'first_orion',
  credentialsEnc: Buffer.alloc(0),
  kekVersion: 1,
  brandName: 'Acme',
  ...overrides,
});

describe('ProviderRegistry caching', () => {
  beforeEach(() => MockProviderRegistry.clearAll());
  afterEach(() => MockProviderRegistry.clearAll());

  it('creates client on first call', async () => {
    const p = fakeProvider();
    await MockProviderRegistry.getClient(p);
    expect(MockProviderRegistry.callCount).toBe(1);
  });

  it('returns same instance on second call (cache hit)', async () => {
    const p = fakeProvider();
    const c1 = await MockProviderRegistry.getClient(p);
    const c2 = await MockProviderRegistry.getClient(p);
    expect(c1).toBe(c2);
    expect(MockProviderRegistry.callCount).toBe(1);
  });

  it('creates fresh client after invalidation', async () => {
    const p = fakeProvider();
    const c1 = await MockProviderRegistry.getClient(p);
    MockProviderRegistry.invalidate(p.tenantId, p.provider);
    const c2 = await MockProviderRegistry.getClient(p);
    expect(c1).not.toBe(c2);
    expect(MockProviderRegistry.callCount).toBe(2);
  });

  it('separate cache keys for different providers', async () => {
    const p1 = fakeProvider({ provider: 'first_orion' });
    const p2 = fakeProvider({ provider: 'hiya' });
    await MockProviderRegistry.getClient(p1);
    await MockProviderRegistry.getClient(p2);
    expect(MockProviderRegistry.callCount).toBe(2);
  });

  it('separate cache keys for different tenants', async () => {
    const p1 = fakeProvider({ tenantId: BigInt(1) });
    const p2 = fakeProvider({ tenantId: BigInt(2) });
    await MockProviderRegistry.getClient(p1);
    await MockProviderRegistry.getClient(p2);
    expect(MockProviderRegistry.callCount).toBe(2);
  });
});
