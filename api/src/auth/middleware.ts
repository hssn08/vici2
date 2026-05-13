// Fastify middleware decorators (M02 PLAN §8.1, F05 PLAN §7).
//
// requireAuth, requireRole, requirePermission (verb+scope), requireTenant,
// requireOwn, requireTotp, requireWsToken, noPermission.
// Composable via @fastify/auth.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyAuth from "@fastify/auth";

import { verifyAccessToken } from "./jwt.js";
import {
  roleAtLeast,
  permsAsSet,
  isRole,
} from "./rbac.js";
import { Can, type AuthContext as RbacAuthContext, type ScopeContext } from "@vici2/auth/rbac";
import { type AuditWriter, auditDecision } from "@vici2/auth/rbac/audit";
import type { Verb, Role } from "@vici2/types";
import type { AccessTokenClaims, Audience } from "@vici2/types";

// ---------------------------------------------------------------------------
// Augment Fastify types
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }

  interface FastifyInstance {
    requireAuth:        (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireWsToken:     (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole:        (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** M02: full verb+scope permission check with audit. */
    requirePermission:  (
      verb: Verb,
      extractScope?: (req: FastifyRequest) => ScopeContext,
      auditWriter?: AuditWriter,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireTenant:      (extract?: (req: FastifyRequest) => number | string | undefined) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwn:         (extract: (req: FastifyRequest) => number | string | undefined) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireTotp:        (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Document intentionally open routes (health, JWKS, metrics). */
    noPermission:       () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ---------------------------------------------------------------------------
// AuthContext — lives on req.auth after requireAuth
// ---------------------------------------------------------------------------

export interface AuthContext {
  uid:              number;
  tenantId:         number;
  role:             Role;
  perms:            Set<Verb>;
  jti:              string;
  totpVerified:     boolean;
  rawClaims:        AccessTokenClaims;
  // M02 additions — used by Can()
  userGroupId:      bigint | null;
  allowedCampaigns: bigint[] | '*';
}

/** Convert AuthContext to the shape expected by Can(). */
export function toRbacAuth(auth: AuthContext): RbacAuthContext {
  return {
    uid:              BigInt(auth.uid),
    tenantId:         BigInt(auth.tenantId),
    role:             auth.role,
    userGroupId:      auth.userGroupId,
    allowedCampaigns: auth.allowedCampaigns,
    perms:            auth.perms as Set<Verb>,
    jti:              auth.jti,
    totpVerified:     auth.totpVerified,
    active:           true, // inactive users are rejected at login; JWT not issued
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim();
}

async function authenticate(req: FastifyRequest, aud: Audience): Promise<AuthContext> {
  const token = extractBearer(req);
  if (!token) throw new AuthError(401, "missing_authorization");
  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(token, { expectedAud: aud });
  } catch (err) {
    throw new AuthError(401, `invalid_token: ${(err as Error).message}`);
  }
  if (!isRole(claims.role)) throw new AuthError(401, "invalid_role");
  const perms = claims.perms ? new Set<Verb>(claims.perms) : permsAsSet(claims.role);

  // M02: hydrate userGroupId + allowedCampaigns from JWT extensions (§6).
  // If claims lack ug/cmps_kind (old tokens), default to '*' for admin roles.
  let userGroupId: bigint | null = null;
  let allowedCampaigns: bigint[] | '*' = '*';

  if ('ug' in claims && claims['ug'] != null) {
    userGroupId = BigInt(claims['ug'] as number);
  }
  const cmpsKind = ('cmps_kind' in claims ? claims['cmps_kind'] : undefined) as string | undefined;
  if (cmpsKind === 'list' && 'cmps' in claims && Array.isArray(claims['cmps'])) {
    allowedCampaigns = (claims['cmps'] as number[]).map(BigInt);
  } else if (cmpsKind === 'all' || claims.role === 'super_admin' || claims.role === 'admin') {
    allowedCampaigns = '*';
  } else if (cmpsKind === 'ref') {
    // >50 campaigns; will be hydrated from Valkey on first request (Phase 2)
    // For now fall back to '*' to avoid denying valid users during rollout
    allowedCampaigns = '*';
  }

  return {
    uid: claims.uid,
    tenantId: claims.tenant_id,
    role: claims.role,
    perms,
    jti: claims.jti,
    totpVerified: claims.totp_verified,
    rawClaims: claims,
    userGroupId,
    allowedCampaigns,
  };
}

export class AuthError extends Error {
  constructor(public statusCode: number, public code: string) {
    super(code);
  }
}

async function sendErr(reply: FastifyReply, status: number, code: string): Promise<void> {
  await reply.code(status).send({ error: code });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerAuthDecorators(app: FastifyInstance): Promise<void> {
  if (!app.hasPlugin?.("@fastify/auth")) {
    await app.register(fastifyAuth);
  }

  app.decorateRequest("auth", undefined);

  // --- requireAuth ---
  app.decorate(
    "requireAuth",
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        req.auth = await authenticate(req, "api");
      } catch (err) {
        if (err instanceof AuthError) {
          await sendErr(reply, err.statusCode, err.code);
          return;
        }
        throw err;
      }
    },
  );

  // --- requireWsToken ---
  app.decorate(
    "requireWsToken",
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        req.auth = await authenticate(req, "ws");
      } catch (err) {
        if (err instanceof AuthError) {
          await sendErr(reply, err.statusCode, err.code);
          return;
        }
        throw err;
      }
    },
  );

  // --- requireRole ---
  app.decorate("requireRole", (role: Role) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) { await sendErr(reply, 401, "not_authenticated"); return; }
      if (!roleAtLeast(req.auth.role, role)) {
        await sendErr(reply, 403, "insufficient_role");
      }
    };
  });

  // --- requirePermission (M02 full implementation) ---
  app.decorate(
    "requirePermission",
    (verb: Verb, extractScope?: (req: FastifyRequest) => ScopeContext, auditWriter?: AuditWriter) => {
      return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        if (!req.auth) { await sendErr(reply, 401, "not_authenticated"); return; }
        const rbacAuth = toRbacAuth(req.auth);
        const scope: ScopeContext = extractScope
          ? extractScope(req)
          : { tenantId: BigInt(req.auth.tenantId) };
        const decision = Can(rbacAuth, verb, scope);

        if (auditWriter) {
          // auditDecision throws if audit write fails → returns 500 not 403
          await auditDecision(auditWriter, rbacAuth, verb, scope, decision);
        }

        if (!decision.allow) {
          await reply.code(403).send({
            error: 'forbidden',
            ...(process.env['NODE_ENV'] !== 'production' && { reason: decision.reason }),
          });
        }
      };
    },
  );

  // --- requireTenant ---
  app.decorate("requireTenant", (extract?: (req: FastifyRequest) => number | string | undefined) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) { await sendErr(reply, 401, "not_authenticated"); return; }
      const ex = extract ?? ((r: FastifyRequest): number | string | undefined => {
        const params = r.params as Record<string, string | undefined> | undefined;
        const body   = r.body   as Record<string, unknown> | undefined;
        return params?.['tenant_id'] ?? params?.['tenantId'] ?? (body?.['tenant_id'] as string | number | undefined);
      });
      const v = ex(req);
      if (v === undefined) return;
      const target = typeof v === "string" ? Number(v) : v;
      if (Number.isNaN(target)) { await sendErr(reply, 400, "invalid_tenant"); return; }
      if (target !== req.auth.tenantId) { await sendErr(reply, 403, "tenant_mismatch"); }
    };
  });

  // --- requireOwn ---
  app.decorate("requireOwn", (extract: (req: FastifyRequest) => number | string | undefined) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) { await sendErr(reply, 401, "not_authenticated"); return; }
      if (roleAtLeast(req.auth.role, "admin")) return; // admin+ bypasses
      const v = extract(req);
      if (v === undefined) { await sendErr(reply, 400, "missing_target"); return; }
      const target = typeof v === "string" ? Number(v) : v;
      if (target !== req.auth.uid) { await sendErr(reply, 403, "not_owner"); }
    };
  });

  // --- requireTotp ---
  app.decorate("requireTotp", async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) { await sendErr(reply, 401, "not_authenticated"); return; }
    if (!req.auth.totpVerified) { await sendErr(reply, 403, "totp_not_verified"); }
  });

  // --- noPermission (documents intentionally open routes) ---
  app.decorate("noPermission", () => {
    return async (_req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      // Intentionally no permission check — see M02 PLAN §8.1
    };
  });
}
