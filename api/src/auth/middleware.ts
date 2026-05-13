// Fastify middleware decorators (PLAN §7).
//
// requireAuth, requireRole, requirePermission, requireTenant, requireOwn,
// requireTotp, requireWsToken. Composable via @fastify/auth.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyAuth from "@fastify/auth";

import { verifyAccessToken } from "./jwt.js";
import {
  hasPermission as hasPerm,
  roleAtLeast,
  permsAsSet,
  isRole,
} from "./rbac.js";
import type { Permission, Role } from "@vici2/types";
import type { AccessTokenClaims, Audience } from "@vici2/types";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }

  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireWsToken: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: Role,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      perm: Permission,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireTenant: (
      extract?: (req: FastifyRequest) => number | string | undefined,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwn: (
      extract: (req: FastifyRequest) => number | string | undefined,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireTotp: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthContext {
  uid: number;
  tenantId: number;
  role: Role;
  perms: Set<Permission>;
  jti: string;
  totpVerified: boolean;
  rawClaims: AccessTokenClaims;
}

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
  const perms = claims.perms ? new Set<Permission>(claims.perms) : permsAsSet(claims.role);
  return {
    uid: claims.uid,
    tenantId: claims.tenant_id,
    role: claims.role,
    perms,
    jti: claims.jti,
    totpVerified: claims.totp_verified,
    rawClaims: claims,
  };
}

export class AuthError extends Error {
  constructor(public statusCode: number, public code: string) {
    super(code);
  }
}

async function send(reply: FastifyReply, status: number, code: string): Promise<void> {
  await reply.code(status).send({ error: code });
}

export async function registerAuthDecorators(app: FastifyInstance): Promise<void> {
  if (!app.hasPlugin?.("@fastify/auth")) {
    await app.register(fastifyAuth);
  }

  app.decorateRequest("auth", undefined);

  app.decorate(
    "requireAuth",
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        req.auth = await authenticate(req, "api");
      } catch (err) {
        if (err instanceof AuthError) {
          await send(reply, err.statusCode, err.code);
          return;
        }
        throw err;
      }
    },
  );

  app.decorate(
    "requireWsToken",
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        req.auth = await authenticate(req, "ws");
      } catch (err) {
        if (err instanceof AuthError) {
          await send(reply, err.statusCode, err.code);
          return;
        }
        throw err;
      }
    },
  );

  app.decorate("requireRole", (role: Role) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) {
        await send(reply, 401, "not_authenticated");
        return;
      }
      if (!roleAtLeast(req.auth.role, role)) {
        await send(reply, 403, "insufficient_role");
      }
    };
  });

  app.decorate("requirePermission", (perm: Permission) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) {
        await send(reply, 401, "not_authenticated");
        return;
      }
      if (!req.auth.perms.has(perm) && !hasPerm(req.auth.role, perm)) {
        await send(reply, 403, "permission_denied");
      }
    };
  });

  app.decorate("requireTenant", (extract?: (req: FastifyRequest) => number | string | undefined) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) {
        await send(reply, 401, "not_authenticated");
        return;
      }
      const ex =
        extract ??
        ((r: FastifyRequest): number | string | undefined => {
          const params = r.params as Record<string, string | undefined> | undefined;
          const body = r.body as Record<string, unknown> | undefined;
          return params?.tenant_id ?? params?.tenantId ?? (body?.tenant_id as string | number | undefined);
        });
      const v = ex(req);
      if (v === undefined) return;
      const target = typeof v === "string" ? Number(v) : v;
      if (Number.isNaN(target)) {
        await send(reply, 400, "invalid_tenant");
        return;
      }
      if (target !== req.auth.tenantId) {
        await send(reply, 403, "tenant_mismatch");
      }
    };
  });

  app.decorate("requireOwn", (extract: (req: FastifyRequest) => number | string | undefined) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.auth) {
        await send(reply, 401, "not_authenticated");
        return;
      }
      // admin+ bypasses self-check
      if (roleAtLeast(req.auth.role, "admin")) return;
      const v = extract(req);
      if (v === undefined) {
        await send(reply, 400, "missing_target");
        return;
      }
      const target = typeof v === "string" ? Number(v) : v;
      if (target !== req.auth.uid) {
        await send(reply, 403, "not_owner");
      }
    };
  });

  app.decorate("requireTotp", async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      await send(reply, 401, "not_authenticated");
      return;
    }
    if (!req.auth.totpVerified) {
      await send(reply, 403, "totp_not_verified");
    }
  });
}
