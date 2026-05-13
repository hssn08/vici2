// M01 — Admin tenant-settings routes.
//
// Route map:
//   GET   /api/admin/settings   — read current tenant settings (tenant:edit)
//   PATCH /api/admin/settings   — update tenant settings (tenant:edit)

import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type { AuthContext } from "../../../auth/middleware.js";
import { TenantSettingsUpdateSchema } from "./schema.js";
import type { TenantSettingsResponse } from "./schema.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function toResponse(t: {
  id: bigint;
  name: string;
  slug: string;
  active: boolean;
  settings: unknown;
  internalDncRetentionYears: number;
  updatedAt: Date;
}): TenantSettingsResponse {
  return {
    id: String(t.id),
    name: t.name,
    slug: t.slug,
    active: t.active,
    settings: (t.settings ?? {}) as Record<string, unknown>,
    internalDncRetentionYears: t.internalDncRetentionYears,
    updatedAt: t.updatedAt.toISOString(),
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
    { preHandler: [app.requireAuth, app.requirePermission("tenant:edit")] },
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
          updatedAt: true,
        },
      });
      if (!tenant) {
        return reply.code(404).send({ code: "not_found", message: "Tenant not found" });
      }
      return reply.send(toResponse(tenant));
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
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }

      const before = await db.tenant.findUnique({
        where: { id: BigInt(auth.tenantId) },
        select: { name: true, settings: true, internalDncRetentionYears: true },
      });
      if (!before) {
        return reply.code(404).send({ code: "not_found", message: "Tenant not found" });
      }

      const updated = await db.$transaction(async (tx) => {
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
          },
          select: {
            id: true,
            name: true,
            slug: true,
            active: true,
            settings: true,
            internalDncRetentionYears: true,
            updatedAt: true,
          },
        });

        await audit({
          tx,
          actorUserId: BigInt(auth.uid),
          actorKind: "user",
          action: "auth.role.changed", // reuse closest available — tenant.edited not in AuditAction
          tenantId: auth.tenantId,
          entityType: "tenant",
          entityId: String(auth.tenantId),
          beforeJson: {
            name: before.name,
            settings: before.settings,
            internalDncRetentionYears: before.internalDncRetentionYears,
          },
          afterJson: {
            name: result.name,
            settings: result.settings,
            internalDncRetentionYears: result.internalDncRetentionYears,
          },
        });

        return result;
      });

      return reply.send(toResponse(updated));
    },
  );
}
