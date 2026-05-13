// JWT signer / verifier — EdDSA primary, RS256 escape hatch (PLAN §1).
// `jose` v5; we control key rotation and JWKS shape directly.

import {
  SignJWT,
  jwtVerify,
  importJWK,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
  errors as joseErrors,
} from "jose";
import { randomUUID } from "node:crypto";

import { env } from "../lib/env.js";
import type { AccessTokenClaims, Audience } from "@vici2/types";
import type { Permission, Role } from "@vici2/types";

interface PrivateKeyEntry {
  kid: string;
  alg: string;
  key: KeyLike | Uint8Array;
}

interface PublicKeyEntry {
  kid: string;
  alg: string;
  key: KeyLike | Uint8Array;
  publicJwk: JWK;
}

let _privateKey: PrivateKeyEntry | null = null;
const _publicKeys = new Map<string, PublicKeyEntry>();
let _initialized = false;

function decodeBase64Json<T>(b64: string, label: string): T {
  if (!b64) throw new Error(`${label} is empty`);
  const raw = Buffer.from(b64, "base64").toString("utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} is not valid base64-encoded JSON: ${(err as Error).message}`);
  }
}

export async function initJwt(): Promise<void> {
  if (_initialized) return;
  const alg = env.jwtAlg;
  if (env.jwtPrivateKeyJwk) {
    const jwk = decodeBase64Json<JWK & { kid?: string }>(
      env.jwtPrivateKeyJwk,
      "VICI2_JWT_PRIVATE_KEY_JWK",
    );
    if (!jwk.kid) throw new Error("private JWK is missing kid");
    const key = (await importJWK(jwk, alg)) as KeyLike;
    _privateKey = { kid: jwk.kid, alg, key };
  }
  if (env.jwtPublicKeysJwks) {
    const jwks = decodeBase64Json<{ keys: (JWK & { kid?: string })[] }>(
      env.jwtPublicKeysJwks,
      "VICI2_JWT_PUBLIC_KEYS_JWKS",
    );
    if (!Array.isArray(jwks.keys)) throw new Error("JWKS missing 'keys' array");
    for (const jwk of jwks.keys) {
      if (!jwk.kid) throw new Error("public JWK missing kid");
      const key = (await importJWK(jwk, alg)) as KeyLike;
      _publicKeys.set(jwk.kid, { kid: jwk.kid, alg, key, publicJwk: jwk });
    }
  }
  _initialized = true;
}

export function resetJwtForTests(): void {
  _privateKey = null;
  _publicKeys.clear();
  _initialized = false;
}

export async function registerKeyPairForTests(
  kid: string,
  alg = "EdDSA",
): Promise<{ kid: string }> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } as JWK;
  _privateKey = { kid, alg, key: privateKey };
  _publicKeys.set(kid, { kid, alg, key: publicKey, publicJwk });
  _initialized = true;
  return { kid };
}

export interface SignAccessTokenInput {
  uid: number;
  tenantId: number;
  role: Role;
  perms?: Permission[];
  totpVerified: boolean;
  aud: Audience;
  ttlSec: number;
}

export interface SignedToken {
  token: string;
  claims: AccessTokenClaims;
}

export async function signAccessToken(input: SignAccessTokenInput): Promise<SignedToken> {
  await initJwt();
  if (!_privateKey) throw new Error("JWT private key not configured");
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: env.jwtIssuer,
    aud: input.aud,
    sub: `u_${input.uid}`,
    uid: input.uid,
    tenant_id: input.tenantId,
    role: input.role,
    iat: now,
    exp: now + input.ttlSec,
    jti: randomUUID(),
    totp_verified: input.totpVerified,
    ...(input.perms ? { perms: input.perms } : {}),
  };
  const jwt = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: _privateKey.alg, kid: _privateKey.kid, typ: "JWT" })
    .sign(_privateKey.key);
  return { token: jwt, claims };
}

export interface VerifyOptions {
  expectedAud: Audience;
  clockToleranceSec?: number;
}

export async function verifyAccessToken(
  token: string,
  opts: VerifyOptions,
): Promise<AccessTokenClaims> {
  await initJwt();
  if (_publicKeys.size === 0) throw new Error("no public keys configured");
  const getKey = (header: { kid?: string }): KeyLike | Uint8Array => {
    if (!header.kid) throw new Error("token missing kid");
    const entry = _publicKeys.get(header.kid);
    if (!entry) throw new Error(`unknown kid: ${header.kid}`);
    return entry.key;
  };
  let payload: Record<string, unknown>;
  try {
    const res = await jwtVerify(
      token,
      (h) => getKey(h as { kid?: string }) as KeyLike,
      {
        issuer: env.jwtIssuer,
        audience: opts.expectedAud,
        clockTolerance: opts.clockToleranceSec ?? 60,
      },
    );
    payload = res.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new Error("token expired");
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      throw new Error(`claim invalid: ${err.message}`);
    }
    throw err;
  }
  if (typeof payload.tenant_id !== "number") throw new Error("tenant_id missing or not number");
  if (typeof payload.uid !== "number") throw new Error("uid missing or not number");
  if (typeof payload.role !== "string") throw new Error("role missing");
  if (typeof payload.totp_verified !== "boolean") throw new Error("totp_verified missing");
  return payload as unknown as AccessTokenClaims;
}

export function publicJwks(): { keys: JWK[] } {
  return { keys: Array.from(_publicKeys.values()).map((e) => e.publicJwk) };
}

export function getActiveKid(): string | null {
  return _privateKey?.kid ?? null;
}
