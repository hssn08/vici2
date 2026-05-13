// N05 — Provider Registry.
// Selects the correct IBrandedCallingProvider given a BrandedCallingProvider row.
// Caches decrypted clients for 15 minutes; invalidated on credential update.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrandedCallingProvider = any; // Prisma-generated; available after `prisma generate`
import { decrypt } from '../../auth/encryption.js';
import type { IBrandedCallingProvider, ProviderKind } from './types.js';
import { FirstOrionClient } from './first-orion.js';
import { HiyaClient } from './hiya.js';
import { TnsClient } from './tns.js';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class ProviderRegistry {
  private static clients = new Map<string, IBrandedCallingProvider>();
  private static timers = new Map<string, ReturnType<typeof setTimeout>>();

  static async getClient(provider: BrandedCallingProvider): Promise<IBrandedCallingProvider> {
    const cacheKey = `${provider.tenantId}:${provider.provider}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const credsJson = decrypt({
      table: 'branded_calling_providers',
      column: 'credentials_enc',
      rowId: provider.id,
      tenantId: provider.tenantId,
      ciphertextBlob: provider.credentialsEnc as unknown as Uint8Array,
    }).toString('utf-8');
    const creds = JSON.parse(credsJson) as Record<string, string>;

    let client: IBrandedCallingProvider;
    switch (provider.provider as ProviderKind) {
      case 'first_orion':
        client = new FirstOrionClient({ clientId: creds['client_id']!, clientSecret: creds['client_secret']! });
        break;
      case 'hiya':
        client = new HiyaClient({ apiKey: creds['api_key']! });
        break;
      case 'tns':
        client = new TnsClient({ apiKey: creds['api_key']!, apiSecret: creds['api_secret']! });
        break;
      default:
        throw new Error(`Unknown provider: ${String(provider.provider)}`);
    }

    this.clients.set(cacheKey, client);

    // Evict after TTL
    const existingTimer = this.timers.get(cacheKey);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.clients.delete(cacheKey);
      this.timers.delete(cacheKey);
    }, CACHE_TTL_MS);
    if (timer.unref) timer.unref();
    this.timers.set(cacheKey, timer);

    return client;
  }

  static invalidate(tenantId: bigint, provider: ProviderKind): void {
    const cacheKey = `${tenantId}:${provider}`;
    this.clients.delete(cacheKey);
    const timer = this.timers.get(cacheKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(cacheKey);
    }
  }

  /** For tests: clear all cached clients. */
  static clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.clients.clear();
    this.timers.clear();
  }
}
