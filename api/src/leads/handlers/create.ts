// D01 — POST /api/leads (PLAN §1.1)
// Create a single lead with phone normalization and audit.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { LeadCreateSchema } from "../schemas.js";
import { strictNormalizePhone, normalizePhone, InvalidPhoneError } from "../normalize.js";
import { auditLead } from "../audit.js";
import { publishLeadEvent } from "../events.js";
import { serializeLead } from "./get.js";

export function registerCreateLeadRoute(app: FastifyInstance): void {
  app.post(
    "/api/leads",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:create"),
      ],
    },
    async (req, reply) => {
      const parsed = LeadCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const body = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const actorUserId = BigInt(req.auth!.uid);
      const prisma = getPrisma();

      // Resolve country code from list if not provided
      const countryCode = body.country_code ?? "US";
      const list = await prisma.list.findFirst({
        where: { id: body.list_id, tenantId },
        select: { id: true },
      });
      if (!list) {
        return reply.code(400).send({ error: "INVALID_LIST_ID", message: "List not found" });
      }

      // Normalize phone
      let phoneE164: string;
      try {
        phoneE164 = strictNormalizePhone(body.phone_e164, countryCode);
      } catch (err) {
        if (err instanceof InvalidPhoneError) {
          return reply.code(400).send({ error: "INVALID_PHONE", message: err.message });
        }
        throw err;
      }

      // Normalize alt phones (soft — don't reject)
      let phoneAlt: string | null = null;
      if (body.phone_alt) {
        try {
          phoneAlt = normalizePhone(body.phone_alt, countryCode).e164;
        } catch {
          phoneAlt = body.phone_alt; // store raw if unparseable
        }
      }

      let phoneAlt2: string | null = null;
      if (body.phone_alt2) {
        try {
          phoneAlt2 = normalizePhone(body.phone_alt2, countryCode).e164;
        } catch {
          phoneAlt2 = body.phone_alt2;
        }
      }

      // Idempotency key — recorded for future idempotency middleware; not yet implemented
      // const idempotencyKey = (req.headers["idempotency-key"] as string) ?? null;

      let lead: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lead = await prisma.$transaction(async (tx: any) => {
          const created = await tx.lead.create({
            data: {
              tenantId,
              listId: body.list_id,
              phoneE164,
              phoneAlt: phoneAlt,
              phoneAlt2: phoneAlt2,
              countryCode,
              title: body.title,
              firstName: body.first_name,
              middleInitial: body.middle_initial,
              lastName: body.last_name,
              address1: body.address1,
              address2: body.address2,
              city: body.city,
              state: body.state,
              postalCode: body.postal_code,
              email: body.email,
              dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : undefined,
              gender: body.gender as "M" | "F" | "U",
              comments: body.comments,
              rank: body.rank,
              ownerUserId: body.owner_user_id ?? null,
              vendorLeadCode: body.vendor_lead_code,
              sourceId: body.source_id,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              customData: (body.custom_data ?? {}) as any,
              status: "NEW",
              version: 1,
            },
          });

          await auditLead({
            tx: tx as Parameters<typeof auditLead>[0]["tx"],
            action: "lead.created",
            tenantId,
            actorUserId,
            entityId: String(created.id),
            after: {
              phone_e164: created.phoneE164,
              email: created.email,
              list_id: String(created.listId),
              status: created.status,
            },
            ip: req.ip,
            userAgent: req.headers["user-agent"],
            requestId: req.id,
          });

          return created;
        }) as Record<string, unknown>;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === "P2002") {
          return reply.code(409).send({
            error: "DUPLICATE_LEAD",
            message: "A lead with this phone already exists in this list",
          });
        }
        throw err;
      }

      // After-commit event publish (best-effort)
      void publishLeadEvent("lead.created", {
        tenant_id: String(tenantId),
        lead_id: String(lead["id"]),
        actor_user_id: String(actorUserId),
        ts: new Date().toISOString(),
        action: "lead.created",
      });

      const serialized = serializeLead(lead);
      return reply
        .header("Location", `/api/leads/${serialized["id"]}`)
        .header("ETag", `"${lead["version"]}"`)
        .code(201)
        .send(serialized);
    },
  );
}
