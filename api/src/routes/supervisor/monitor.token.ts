// monitor.token.ts — mint and validate monitor grant tokens.
//
// Monitor grant tokens are SHORT-LIVED (60 s), single-use JWTs minted by
// POST /api/sup/monitor/start. They carry tid + target_uid + initial_mode
// so the dialplan re-validation endpoint can verify them without a DB round-trip.
//
// JTI is stored in Valkey (SET NX EX 90) to enforce one-time use.
// S02 PLAN §5.1.

import { SignJWT, jwtVerify, type KeyLike } from "jose";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export const MONITOR_TOKEN_AUD = "vici2-monitor-grant";
export const MONITOR_TOKEN_TTL_SEC = 60;
const MONITOR_JTI_VALKEY_TTL_SEC = 90; // slight buffer over token TTL

export interface MonitorGrantClaims {
  iss: string;
  aud: string;
  sub: string;
  uid: number;
  tid: number;
  role: string;
  monitor_target_uid: number;
  monitor_initial_mode: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface MonitorGrantResult {
  token: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Mint a 60-second monitor grant token and store the JTI in Valkey.
 * S02 PLAN §5.1 steps 5–6.
 */
export async function mintMonitorGrantToken(opts: {
  issuer: string;
  privateKey: KeyLike | Uint8Array;
  kid: string;
  alg: string;
  uid: number;
  tid: number;
  role: string;
  targetUid: number;
  initialMode: string;
  redis: Redis;
}): Promise<MonitorGrantResult> {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const exp = now + MONITOR_TOKEN_TTL_SEC;

  const claims: MonitorGrantClaims = {
    iss: opts.issuer,
    aud: MONITOR_TOKEN_AUD,
    sub: `u_${opts.uid}`,
    uid: opts.uid,
    tid: opts.tid,
    role: opts.role,
    monitor_target_uid: opts.targetUid,
    monitor_initial_mode: opts.initialMode,
    iat: now,
    exp,
    jti,
  };

  const token = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: opts.alg, kid: opts.kid, typ: "JWT" })
    .sign(opts.privateKey);

  // Store JTI in Valkey (NX = only if not exists — replay guard).
  // S02 PLAN §12.1: vici2:monitor:jti:<jti>
  const jtiKey = `vici2:monitor:jti:${jti}`;
  await opts.redis.set(jtiKey, "1", "EX", MONITOR_JTI_VALKEY_TTL_SEC, "NX");

  return { token, jti, expiresAt: new Date(exp * 1000) };
}

/**
 * Validate and single-consume a monitor grant token.
 * Used by the FS dialplan authz endpoint.
 *
 * Throws MonitorTokenError on any validation failure.
 */
export async function validateAndConsumeMonitorToken(opts: {
  token: string;
  issuer: string;
  getKey: (header: { kid?: string }) => KeyLike | Uint8Array;
  redis: Redis;
}): Promise<MonitorGrantClaims> {
  let payload: MonitorGrantClaims;

  try {
    const result = await jwtVerify(
      opts.token,
      (h) => opts.getKey(h as { kid?: string }) as KeyLike,
      { issuer: opts.issuer, audience: MONITOR_TOKEN_AUD, clockTolerance: 10 },
    );
    payload = result.payload as unknown as MonitorGrantClaims;
  } catch (err) {
    throw new MonitorTokenError("token_invalid", `JWT verify: ${(err as Error).message}`);
  }

  // One-time use: DEL the JTI. Returns 0 if already consumed / never existed.
  const jtiKey = `vici2:monitor:jti:${payload.jti}`;
  const deleted = await opts.redis.del(jtiKey);
  if (deleted === 0) {
    throw new MonitorTokenError("token_replay", "JTI already consumed or expired");
  }

  return payload;
}

export class MonitorTokenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MonitorTokenError";
  }
}
