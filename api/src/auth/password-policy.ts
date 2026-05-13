// Password policy: min length + HIBP k-anonymity check with cache (PLAN §3.5).

import { createHash } from "node:crypto";
import { Redis } from "ioredis";

import { env } from "../lib/env.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export interface PolicyResult {
  ok: boolean;
  reason?: "too_short" | "too_long" | "pwned";
}

export function checkLength(password: string): PolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true };
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let _fetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "Add-Padding": "true" } });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export function setHibpFetcherForTests(fn: Fetcher | null): void {
  _fetch = fn ?? (async (url) => {
    const res = await fetch(url, { headers: { "Add-Padding": "true" } });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  });
}

export interface HibpOptions {
  redis?: Redis;
  cacheTtlSec?: number;
}

export async function isPwned(password: string, opts: HibpOptions = {}): Promise<boolean> {
  // Read process.env each time so tests can toggle without re-importing.
  const offlineEnv = process.env.HIBP_OFFLINE;
  const offline = offlineEnv === undefined ? env.hibpOffline : !/^(false|0|no|off|)$/i.test(offlineEnv);
  if (offline) return false;
  const sha1 = createHash("sha1").update(password, "utf-8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const cacheKey = `cache:hibp:${prefix}`;
  if (opts.redis) {
    const cached = await opts.redis.get(cacheKey);
    if (cached !== null) {
      return cached.includes(suffix);
    }
  }

  let body: string;
  try {
    const res = await _fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (!res.ok) return false; // fail-open per PLAN §17.1
    body = await res.text();
  } catch {
    return false;
  }
  const matches = body
    .split(/\r?\n/)
    .map((l) => l.split(":")[0]?.trim().toUpperCase() ?? "")
    .filter(Boolean);
  if (opts.redis) {
    await opts.redis.set(cacheKey, matches.join(","), "EX", opts.cacheTtlSec ?? 86400);
  }
  return matches.includes(suffix);
}

export async function checkPassword(
  password: string,
  opts: HibpOptions = {},
): Promise<PolicyResult> {
  const len = checkLength(password);
  if (!len.ok) return len;
  if (await isPwned(password, opts)) return { ok: false, reason: "pwned" };
  return { ok: true };
}
