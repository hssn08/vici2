// Redis/Valkey client singleton + script-loader helper. Used by F05 refresh-
// token store, lockout, and HIBP cache. F04 owns the helper library; F05
// inlines a minimal client here until F04 ships.

import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env.js";

let _client: Redis | null = null;
const scriptShaCache = new Map<string, string>();

export interface RedisLike {
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  hset(key: string, ...args: (string | number)[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

export function getRedis(opts?: RedisOptions): Redis {
  if (_client) return _client;
  _client = new Redis(env.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...opts,
  });
  return _client;
}

export function setRedisForTests(client: Redis | null): void {
  _client = client;
  scriptShaCache.clear();
}

export async function loadScript(client: Redis, name: string, source: string): Promise<string> {
  const cached = scriptShaCache.get(name);
  if (cached) return cached;
  const sha = await client.script("LOAD", source);
  if (typeof sha !== "string") throw new Error("SCRIPT LOAD returned non-string");
  scriptShaCache.set(name, sha);
  return sha;
}

export async function evalshaWithReload(
  client: Redis,
  name: string,
  source: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  // Try EVALSHA-with-LOAD path (real Redis/Valkey). Fall back to plain EVAL
  // for environments (e.g., ioredis-mock) that don't implement SCRIPT LOAD.
  let sha: string;
  try {
    sha = await loadScript(client, name, source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("unsupported") || msg.includes("script")) {
      return await client.eval(source, keys.length, ...keys, ...args);
    }
    throw err;
  }
  try {
    return await client.evalsha(sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (err instanceof Error && err.message.includes("NOSCRIPT")) {
      scriptShaCache.delete(name);
      const fresh = await loadScript(client, name, source);
      return await client.evalsha(fresh, keys.length, ...keys, ...args);
    }
    throw err;
  }
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
    scriptShaCache.clear();
  }
}
