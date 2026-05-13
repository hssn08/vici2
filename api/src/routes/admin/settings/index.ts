// M05 — Admin tenant-settings routes.
//
// Route map:
//   GET   /api/admin/settings   — read current tenant settings (tenant:read)
//   PATCH /api/admin/settings   — update tenant settings (tenant:edit / super_admin)
//
// M05 extends the M01 contract with auth_config, consentMinimumMode,
// defaultCallerState, unknownTzPolicyDefault, pacingDefaults, supportEmail.

import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type { AuthContext } from "../../../auth/middleware.js";
import {
  TenantSettingsUpdateSchema,
  type TenantSettingsResponse,
  type AuthConfigResponse,
} from "./schema.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

// ---------------------------------------------------------------------------
// Defaults for auth_config when the row is absent (mirrors F05 env defaults)
// ---------------------------------------------------------------------------

const AUTH_CONFIG_DEFAULTS: AuthConfigResponse = {
  passwordMinLength: 12,
  lockoutAfterFailures: 5,
  lockoutWindowSeconds: 900,
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  totpGracePeriodDays: 7,
};

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function toResponse(
  t: {
    id: bigint;
    name: string;
    slug: string;
    active: boolean;
    settings: unknown;
    internalDncRetentionYears: number;
    consentMinimumMode: string;
    defaultCallerState: string | null;
    updatedAt: Date;
  },
  authCfg: AuthConfigResponse,
): TenantSettingsResponse {
  return {
    id: String(t.id),
    name: t.name,
    slug: t.slug,
    active: t.active,
    settings: (t.settings ?? {}) as Record<string, unknown>,
    internalDncRetentionYears: t.internalDncRetentionYears,
    updatedAt: t.updatedAt.toISOString(),
    // M05 additions
    consentMinimumMode: t.consentMinimumMode,
    defaultCallerState: t.defaultCallerState,
    auth: authCfg,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminSettingsRoutes(app: any): Promise<void> {
  const db = getPrisma();

  // -------------------------------------------------------------------------
  // GET /api/admin/settings
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/settings",
    { preHandler: [app.requireAuth, app.requirePermission("tenant:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenant = await db.tenant.findUnique({
        where: { id: BigInt(auth.tenantId) },
        select: {
          id: true,
          name: true,
          slug: true,
          active: true,
          settings: true,
          internalDncRetentionYears: true,
          consentMinimumMode: true,
          defaultCallerState: true,
          updatedAt: true,
        },
      });
      if (!tenant) {
        return reply.code(404).send({ code: "not_found", message: "Tenant not found" });
      }

      // Read auth_config (single-row table — id=1). If absent, use defaults.
      const authCfgRow = await db.authConfig.findUnique({ where: { id: 1 } });
      const authCfg: AuthConfigResponse = authCfgRow
        ? {
            passwordMinLength: authCfgRow.passwordMinLength,
            lockoutAfterFailures: authCfgRow.lockoutAfterFailures,
            lockoutWindowSeconds: authCfgRow.lockoutWindowSeconds,
            accessTokenTtlSeconds: authCfgRow.accessTokenTtlSeconds,
            refreshTokenTtlSeconds: authCfgRow.refreshTokenTtlSeconds,
            totpGracePeriodDays: authCfgRow.totpGracePeriodDays,
          }
        : AUTH_CONFIG_DEFAULTS;

      return reply.send(toResponse(tenant, authCfg));
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/settings
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/settings",
    { preHandler: [app.requireAuth, app.requirePermission("tenant:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = TenantSettingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: "validation_error", message: parsed.error.message });
      }

      // auth sub-object is super_admin only (tenant:edit is sensitive but
      // both admin + super_admin have it; auth policy is super_admin-only)
      if (parsed.data.auth !== undefined && auth.role !== "super_admin") {
        return reply.code(403).send({
          code: "forbidden",
          message: "Only super_admin may change authentication policy",
        });
      }

      const before = await db.tenant.findUnique({
        where: { id: BigInt(auth.tenantId) },
        select: {
          name: true,
          settings: true,
          internalDncRetentionYears: true,
          consentMinimumMode: true,
          defaultCallerState: true,
        },
      });
      if (!before) {
        return reply.code(404).send({ code: "not_found", message: "Tenant not found" });
      }

      const beforeAuthCfg = await db.authConfig.findUnique({ where: { id: 1 } });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await db.$transaction(async (tx: any) => {
        // Update tenant row
        const result = await tx.tenant.update({
          where: { id: BigInt(auth.tenantId) },
          data: {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.settings !== undefined
              ? {
                  settings: {
                    ...(before.settings as Record<string, unknown>),
                    ...parsed.data.settings,
                  } as Prisma.InputJsonValue,
                }
              : {}),
            ...(parsed.data.internalDncRetentionYears !== undefined
              ? { internalDncRetentionYears: parsed.data.internalDncRetentionYears }
              : {}),
            ...(parsed.data.consentMinimumMode !== undefined
              ? { consentMinimumMode: parsed.data.consentMinimumMode }
              : {}),
            ...(parsed.data.defaultCallerState !== undefined
              ? { defaultCallerState: parsed.data.defaultCallerState ?? null }
              : {}),
          },
          select: {
            id: true,
            name: true,
            slug: true,
            active: true,
            settings: true,
            internalDncRetentionYears: true,
            consentMinimumMode: true,
            defaultCallerState: true,
            updatedAt: true,
          },
        });

        // Upsert auth_config if auth sub-object present (super_admin gate applied above)
        let authCfgResult: AuthConfigResponse = beforeAuthCfg
          ? {
              passwordMinLength: beforeAuthCfg.passwordMinLength,
              lockoutAfterFailures: beforeAuthCfg.lockoutAfterFailures,
              lockoutWindowSeconds: beforeAuthCfg.lockoutWindowSeconds,
              accessTokenTtlSeconds: beforeAuthCfg.accessTokenTtlSeconds,
              refreshTokenTtlSeconds: beforeAuthCfg.refreshTokenTtlSeconds,
              totpGracePeriodDays: beforeAuthCfg.totpGracePeriodDays,
            }
          : { ...AUTH_CONFIG_DEFAULTS };

        if (parsed.data.auth) {
          const a = parsed.data.auth;
          const upserted = await tx.authConfig.upsert({
            where: { id: 1 },
            create: {
              id: 1,
              passwordMinLength:
                a.passwordMinLength ?? AUTH_CONFIG_DEFAULTS.passwordMinLength,
              lockoutAfterFailures:
                a.lockoutAfterFailures ?? AUTH_CONFIG_DEFAULTS.lockoutAfterFailures,
              lockoutWindowSeconds:
                a.lockoutWindowSeconds ?? AUTH_CONFIG_DEFAULTS.lockoutWindowSeconds,
              accessTokenTtlSeconds:
                a.accessTokenTtlSeconds ?? AUTH_CONFIG_DEFAULTS.accessTokenTtlSeconds,
              refreshTokenTtlSeconds:
                a.refreshTokenTtlSeconds ?? AUTH_CONFIG_DEFAULTS.refreshTokenTtlSeconds,
              totpGracePeriodDays:
                a.totpGracePeriodDays ?? AUTH_CONFIG_DEFAULTS.totpGracePeriodDays,
            },
            update: {
              ...(a.passwordMinLength !== undefined
                ? { passwordMinLength: a.passwordMinLength }
                : {}),
              ...(a.lockoutAfterFailures !== undefined
                ? { lockoutAfterFailures: a.lockoutAfterFailures }
                : {}),
              ...(a.lockoutWindowSeconds !== undefined
                ? { lockoutWindowSeconds: a.lockoutWindowSeconds }
                : {}),
              ...(a.accessTokenTtlSeconds !== undefined
                ? { accessTokenTtlSeconds: a.accessTokenTtlSeconds }
                : {}),
              ...(a.refreshTokenTtlSeconds !== undefined
                ? { refreshTokenTtlSeconds: a.refreshTokenTtlSeconds }
                : {}),
              ...(a.totpGracePeriodDays !== undefined
                ? { totpGracePeriodDays: a.totpGracePeriodDays }
                : {}),
            },
          });
          authCfgResult = {
            passwordMinLength: upserted.passwordMinLength,
            lockoutAfterFailures: upserted.lockoutAfterFailures,
            lockoutWindowSeconds: upserted.lockoutWindowSeconds,
            accessTokenTtlSeconds: upserted.accessTokenTtlSeconds,
            refreshTokenTtlSeconds: upserted.refreshTokenTtlSeconds,
            totpGracePeriodDays: upserted.totpGracePeriodDays,
          };
        }

        await audit({
          tx,
          actorUserId: BigInt(auth.uid),
          actorKind: "user",
          action: "tenant.settings.updated",
          tenantId: auth.tenantId,
          entityType: "tenant",
          entityId: String(auth.tenantId),
          beforeJson: {
            name: before.name,
            settings: before.settings,
            internalDncRetentionYears: before.internalDncRetentionYears,
            consentMinimumMode: before.consentMinimumMode,
            defaultCallerState: before.defaultCallerState,
            auth: beforeAuthCfg
              ? {
                  passwordMinLength: beforeAuthCfg.passwordMinLength,
                  lockoutAfterFailures: beforeAuthCfg.lockoutAfterFailures,
                  lockoutWindowSeconds: beforeAuthCfg.lockoutWindowSeconds,
                  accessTokenTtlSeconds: beforeAuthCfg.accessTokenTtlSeconds,
                  refreshTokenTtlSeconds: beforeAuthCfg.refreshTokenTtlSeconds,
                  totpGracePeriodDays: beforeAuthCfg.totpGracePeriodDays,
                }
              : null,
          },
          afterJson: {
            name: result.name,
            settings: result.settings,
            internalDncRetentionYears: result.internalDncRetentionYears,
            consentMinimumMode: result.consentMinimumMode,
            defaultCallerState: result.defaultCallerState,
            auth: authCfgResult,
          },
        });

        return { result, authCfgResult };
      });

      return reply.send(toResponse(updated.result, updated.authCfgResult));
    },
  );
}
