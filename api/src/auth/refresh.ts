// Refresh-token family rotation backed by Valkey (PLAN §2).
//
// - Token = 32 random bytes, base64url (43 chars).
// - Stored key is t:{tid}:auth:refresh:{family_id}:{token_hash} (HASH).
// - On consume, atomic GETDEL via Lua. Miss + family present == reuse attack.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Redis } from "ioredis";

import { evalshaWithReload } from "../lib/redis.js";
import type { Role } from "@vici2/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REFRESH_SCRIPT = readFileSync(
  join(__dirname, "lua", "refresh_consume.v1.lua"),
  "utf-8",
);

export interface IssueRefreshParams {
  redis: Redis;
  tenantId: number;
  userId: number;
  role: Role;
  ttlSec: number;
  familyId?: string;
  parentTokenHash?: string;
  ip?: string;
  ua?: string;
}

export interface IssuedRefresh {
  token: string;
  tokenHash: string;
  familyId: string;
  expiresAt: number;
}

export interface ConsumeResult {
  outcome: "ok" | "reuse" | "not_found";
  userId?: number;
  tenantId?: number;
  familyId?: string;
  role?: Role;
  parentTokenHash?: string;
  expiresAt?: number;
  keysRevoked?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateRefreshToken(): { token: string; tokenHash: string } {
  const raw = randomBytes(32);
  const token = b64url(raw);
  const tokenHash = sha256Hex(token);
  return { token, tokenHash };
}

function familyKey(tenantId: number, familyId: string): string {
  return `t:${tenantId}:auth:refresh:family:${familyId}`;
}

function tokenKey(tenantId: number, familyId: string, tokenHash: string): string {
  return `t:${tenantId}:auth:refresh:${familyId}:${tokenHash}`;
}

function userKey(tenantId: number, userId: number): string {
  return `t:${tenantId}:auth:refresh:user:${userId}`;
}

function newUuidV7(): string {
  // Lightweight UUID v7 — millisecond timestamp + random. Avoids extra deps.
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = randomBytes(10);
  rand[0] = (rand[0]! & 0x0f) | 0x70;
  rand[2] = (rand[2]! & 0x3f) | 0x80;
  const hex =
    tsHex.slice(0, 8) +
    "-" +
    tsHex.slice(8, 12) +
    "-" +
    rand.slice(0, 2).toString("hex") +
    "-" +
    rand.slice(2, 4).toString("hex") +
    "-" +
    rand.slice(4, 10).toString("hex");
  return hex;
}

export async function issueRefreshToken(p: IssueRefreshParams): Promise<IssuedRefresh> {
  const { token, tokenHash } = generateRefreshToken();
  const familyId = p.familyId ?? newUuidV7();
  const expiresAt = Math.floor(Date.now() / 1000) + p.ttlSec;
  const tKey = tokenKey(p.tenantId, familyId, tokenHash);
  const fKey = familyKey(p.tenantId, familyId);
  const uKey = userKey(p.tenantId, p.userId);

  await p.redis
    .multi()
    .hset(tKey, {
      user_id: String(p.userId),
      tenant_id: String(p.tenantId),
      family_id: familyId,
      parent_token_hash: p.parentTokenHash ?? "",
      role: p.role,
      issued_at: String(Math.floor(Date.now() / 1000)),
      expires_at: String(expiresAt),
      last_ip: p.ip ?? "",
      last_ua: p.ua ?? "",
    })
    .expire(tKey, p.ttlSec)
    .sadd(fKey, tokenHash)
    .expire(fKey, p.ttlSec)
    .sadd(uKey, familyId)
    .exec();

  return { token, tokenHash, familyId, expiresAt };
}

export async function consumeRefreshToken(
  redis: Redis,
  tenantId: number,
  familyId: string,
  token: string,
  userIdHint?: number,
): Promise<ConsumeResult> {
  const tokenHash = sha256Hex(token);
  const keys = [
    tokenKey(tenantId, familyId, tokenHash),
    familyKey(tenantId, familyId),
    userIdHint !== undefined ? userKey(tenantId, userIdHint) : "",
  ];
  const raw = (await evalshaWithReload(
    redis,
    "refresh_consume.v1",
    REFRESH_SCRIPT,
    keys,
    [familyId],
  )) as unknown[];

  if (!Array.isArray(raw) || raw.length === 0) return { outcome: "not_found" };
  const status = String(raw[0]);

  if (status === "OK") {
    return {
      outcome: "ok",
      userId: raw[1] ? Number(raw[1]) : undefined,
      tenantId: raw[2] ? Number(raw[2]) : undefined,
      familyId: raw[3] ? String(raw[3]) : undefined,
      role: raw[4] ? (String(raw[4]) as Role) : undefined,
      parentTokenHash: raw[5] ? String(raw[5]) : undefined,
      expiresAt: raw[6] ? Number(raw[6]) : undefined,
    };
  }
  if (status === "REUSE_DETECTED") {
    return {
      outcome: "reuse",
      familyId: String(raw[1]),
      keysRevoked: Number(raw[2]),
    };
  }
  return { outcome: "not_found" };
}

export async function revokeAllForUser(
  redis: Redis,
  tenantId: number,
  userId: number,
): Promise<number> {
  const uKey = userKey(tenantId, userId);
  const families = await redis.smembers(uKey);
  let revoked = 0;
  for (const fid of families) {
    const fKey = familyKey(tenantId, fid);
    const members = await redis.smembers(fKey);
    for (const hash of members) {
      revoked += await redis.del(tokenKey(tenantId, fid, hash));
    }
    await redis.del(fKey);
  }
  await redis.del(uKey);
  return revoked;
}

export async function revokeFamily(
  redis: Redis,
  tenantId: number,
  familyId: string,
  userId?: number,
): Promise<number> {
  const fKey = familyKey(tenantId, familyId);
  const members = await redis.smembers(fKey);
  let revoked = 0;
  for (const hash of members) {
    revoked += await redis.del(tokenKey(tenantId, familyId, hash));
  }
  await redis.del(fKey);
  if (userId !== undefined) {
    await redis.srem(userKey(tenantId, userId), familyId);
  }
  return revoked;
}
