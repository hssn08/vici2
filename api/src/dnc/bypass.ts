// D05 — DNC bypass token mint / redeem helpers (PLAN §6.6 + §7).

import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;

const __dir = dirname(fileURLToPath(import.meta.url));
const LUA_SCRIPT = readFileSync(
  join(__dir, "lua", "redeem_dnc_bypass.v1.lua"),
  "utf8",
);

// ── Key helpers ───────────────────────────────────────────────────────────────

function bypassKey(tenantId: number, tokenHash: string): string {
  return `t:${tenantId}:dnc:bypass:${tokenHash}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashJustification(justification: string): string {
  return createHash("sha256").update(justification).digest("hex");
}

// ── Mint ──────────────────────────────────────────────────────────────────────

export interface MintBypassResult {
  token: string;
  expiresAt: Date;
}

/**
 * Mint a single-use DNC bypass token.
 * Stores payload in Valkey with TTL; returns raw token for caller to surface once.
 */
export async function mintBypassToken(
  redis: AnyRedis,
  opts: {
    tenantId: number;
    phone: string;
    source: string;
    userId: number;
    justification: string;
    ttlSeconds?: number;
  },
): Promise<MintBypassResult> {
  const ttl = Math.min(opts.ttlSeconds ?? 60, 300);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const key = bypassKey(opts.tenantId, tokenHash);
  const justHash = hashJustification(opts.justification);
  const payload = `${opts.phone}|${opts.source}|${opts.userId}|${justHash}`;

   
  const ok = await redis.set(key, payload, "NX", "EX", ttl);
  if (!ok) {
    // Collision — astronomically unlikely with 32 random bytes; retry once
    throw new Error("bypass_token_collision");
  }

  const expiresAt = new Date(Date.now() + ttl * 1000);
  return { token, expiresAt };
}

// ── Redeem ────────────────────────────────────────────────────────────────────

export type RedeemResult = "ok" | "mismatch" | "expired";

/**
 * Redeem a bypass token atomically via Lua GETDEL.
 * Returns the redemption outcome.
 */
export async function redeemBypassToken(
  redis: AnyRedis,
  opts: {
    tenantId: number;
    token: string;
    phone: string;
    source: string;
    userId: number;
    justification: string;
  },
): Promise<RedeemResult> {
  const tokenHash = hashToken(opts.token);
  const key = bypassKey(opts.tenantId, tokenHash);
  const justHash = hashJustification(opts.justification);
  const expectedPayload = `${opts.phone}|${opts.source}|${opts.userId}|${justHash}`;

   
  const result = await redis.eval(LUA_SCRIPT, 1, key, expectedPayload) as string | null;

  if (result === null || result === undefined) return "expired";
  if (result === "MISMATCH") return "mismatch";
  if (result === "OK") return "ok";
  return "expired";
}
