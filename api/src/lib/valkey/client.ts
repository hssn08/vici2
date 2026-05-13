// F04 PLAN §7.1 — api-side Valkey client wrapper. Mirrors the Go
// surface in `dialer/internal/valkey`. ioredis 5 is the underlying lib.

// ioredis is CommonJS — default-import the constructor.
import { Redis, type RedisOptions } from "ioredis";

import { Keys } from "./keys.js";
import { ScriptRegistry } from "./scripts.js";

export interface VRedisConfig {
  stateUrl: string;
  cacheUrl?: string;
  password?: string;
  tenantId?: number;
  /** Directory holding the .lua files; defaults to bundled package copy. */
  luaDir?: string;
}

export class VRedisClient {
  readonly state: Redis;
  readonly cache: Redis;
  readonly keys: Keys;
  readonly scripts: ScriptRegistry;

  private constructor(state: Redis, cache: Redis, keys: Keys, scripts: ScriptRegistry) {
    this.state = state;
    this.cache = cache;
    this.keys = keys;
    this.scripts = scripts;
  }

  static async create(cfg: VRedisConfig): Promise<VRedisClient> {
    const baseOpts: Partial<RedisOptions> = {
      // ioredis 5 expects undefined password rather than empty string.
      password: cfg.password || undefined,
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
      lazyConnect: false,
    };

    const state = new Redis(cfg.stateUrl, baseOpts as RedisOptions);
    const cache =
      cfg.cacheUrl && cfg.cacheUrl !== cfg.stateUrl
        ? new Redis(cfg.cacheUrl, baseOpts as RedisOptions)
        : new Redis(cfg.stateUrl, { ...baseOpts, db: 1 } as RedisOptions);

    const keys = new Keys(cfg.tenantId ?? 1);
    const scripts = new ScriptRegistry(cfg.luaDir);
    try {
      await scripts.loadAll(state);
    } catch (err) {
      // Don't fail construction — caller may want to retry. NOSCRIPT
      // path will lazy-load on first eval anyway.
       
      console.warn("valkey: initial SCRIPT LOAD failed, will lazy-load on first use:", err);
    }
    return new VRedisClient(state, cache, keys, scripts);
  }

  /** Resolve the configured connection from env vars, F04 PLAN §7.1 order. */
  static fromEnv(): Promise<VRedisClient> {
    const url =
      process.env.VALKEY_STATE_URL ||
      process.env.VALKEY_URL ||
      process.env.REDIS_URL;
    if (!url) {
      throw new Error("valkey: no VALKEY_STATE_URL / VALKEY_URL / REDIS_URL set");
    }
    const cacheUrl = process.env.VALKEY_CACHE_URL || url;
    const tenantId = Number(process.env.VICI2_DEFAULT_TENANT_ID ?? 1);
    return VRedisClient.create({
      stateUrl: url,
      cacheUrl,
      password: process.env.VALKEY_PASSWORD,
      tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : 1,
    });
  }

  async ping(): Promise<void> {
    const r = await this.state.ping();
    if (r !== "PONG") throw new Error(`valkey: unexpected PING reply: ${r}`);
  }

  /**
   * Returns true if the connected Valkey has the `valkey-bloom` (or
   * RedisBloom-compatible `bf`) module loaded.
   */
  async hasBloomModule(): Promise<boolean> {
    const res = (await this.state.call("MODULE", "LIST")) as unknown;
    if (!Array.isArray(res)) return false;
    for (const m of res) {
      if (!Array.isArray(m)) continue;
      for (let i = 0; i + 1 < m.length; i += 2) {
        if (m[i] === "name" && (m[i + 1] === "bf" || m[i + 1] === "valkey-bloom")) {
          return true;
        }
      }
    }
    return false;
  }

  async close(): Promise<void> {
    await this.state.quit().catch(() => undefined);
    await this.cache.quit().catch(() => undefined);
  }
}
