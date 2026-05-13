// D01 — POST /api/lead-fields/:k/index (PLAN §5.5)
// Promote a custom_data key to a virtual generated column + index.
// super_admin only.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { FieldKeyParamSchema } from "../schemas.js";
import { promoteCustomField } from "../sql/promote-field.sql.js";
import { auditLead } from "../audit.js";

export function registerPromoteFieldRoute(app: FastifyInstance): void {
  app.post(
    "/api/lead-fields/:k/index",
    {
      preValidation: [
        app.requireAuth,
      ],
    },
    async (req, reply) => {
      // super_admin only
      if (req.auth?.role !== "super_admin") {
        return reply.code(403).send({ error: "FORBIDDEN", message: "super_admin only" });
      }

      const parsed = FieldKeyParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_FIELD_KEY",
          message: "Field key must match ^[a-z_][a-z0-9_]{0,30}$",
          issues: parsed.error.issues,
        });
      }

      const { k } = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const actorUserId = BigInt(req.auth!.uid);
      const prisma = getPrisma();

      let ddl: string;
      try {
        ddl = await promoteCustomField(prisma, k);
      } catch (err: unknown) {
        const error = err as { message?: string };
        return reply.code(500).send({
          error: "DDL_FAILED",
          message: error?.message ?? "DDL execution failed",
        });
      }

      // Audit the promotion
      await auditLead({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx: prisma as any,
        action: "lead.field_indexed",
        tenantId,
        actorUserId,
        entityId: k,
        after: { key: k, ddl },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });

      return reply.code(200).send({
        ok: true,
        key: k,
        column: `cf_${k}`,
        index: `idx_t_cf_${k}`,
        ddl,
      });
    },
  );
}
