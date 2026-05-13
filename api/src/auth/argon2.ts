// Argon2id hashing + verification with HMAC pepper (PLAN §3).
// @node-rs/argon2 — rust binding; phc-encoded output stores params.

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

// `Algorithm` from @node-rs/argon2 is a const enum; with isolatedModules we
// can't reference it at runtime. Literal 2 == Argon2id.
const ARGON2ID_ALGO = 2 as const;
import { createHmac } from "node:crypto";

import { env } from "../lib/env.js";

export interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_PARAMS: Argon2Params = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

let _params: Argon2Params = { ...DEFAULT_PARAMS };

export function setArgon2Params(p: Argon2Params): void {
  _params = { ...p };
}

export function getArgon2Params(): Argon2Params {
  return { ..._params };
}

function pepperedInput(password: string): string {
  if (!env.passwordPepper) {
    return password;
  }
  const keyBytes = Buffer.from(env.passwordPepper, "base64");
  // Hex-encode the HMAC digest so the result is pure ASCII — @node-rs/argon2's
  // verify() requires valid UTF-8 input. Hex preserves all 256 bits of entropy.
  return createHmac("sha256", keyBytes).update(password, "utf-8").digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(pepperedInput(password), {
    algorithm: ARGON2ID_ALGO,
    memoryCost: _params.memoryCost,
    timeCost: _params.timeCost,
    parallelism: _params.parallelism,
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argonVerify(encoded, pepperedInput(password));
  } catch {
    return false;
  }
}

export interface HashParamsFromEncoded {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export function parsePhcParams(encoded: string): HashParamsFromEncoded | null {
  // Format: $argon2id$v=19$m=...,t=...,p=...$salt$hash
  const parts = encoded.split("$");
  if (parts.length < 4 || parts[1] !== "argon2id") return null;
  const paramSeg = parts[3];
  if (!paramSeg) return null;
  let m = 0;
  let t = 0;
  let p = 0;
  for (const kv of paramSeg.split(",")) {
    const [k, vStr] = kv.split("=");
    const v = Number(vStr);
    if (k === "m") m = v;
    else if (k === "t") t = v;
    else if (k === "p") p = v;
  }
  if (!m || !t || !p) return null;
  return { memoryCost: m, timeCost: t, parallelism: p };
}

export function needsRehash(encoded: string): boolean {
  const parsed = parsePhcParams(encoded);
  if (!parsed) return true;
  return (
    parsed.memoryCost < _params.memoryCost ||
    parsed.timeCost < _params.timeCost ||
    parsed.parallelism < _params.parallelism
  );
}
