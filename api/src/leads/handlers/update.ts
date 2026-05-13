// D01 — PATCH /api/leads/:id (PLAN §3)
// Optimistic-lock via If-Match: "<version>" or body.version.
// Bumps version on success; returns 412 on stale.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { IdParamSchema, LeadPatchSchema } from "../schemas.js";
import { normalizePhone, strictNormalizePhone, InvalidPhoneError } from "../normalize.js";
import { auditLead, diffLeadChanges } from "../audit.js";
import { publishLeadEvent } from "../events.js";
import { serializeLead } from "./get.js";

function parseVersion(raw: string | undefined): number | null {
  if (!raw) return null;
  // Accept both strong "5" and weak W/"5"
  const clean = raw.replace(/^W\//, "").replace(/"/g, "");
  const n = parseInt(clean, 10);
  return isNaN(n) ? null : n;
}

export function registerUpdateLeadRoute(app: FastifyInstance): void {
  app.patch(
    "/api/leads/:id",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:edit"),
      ],
    },
    async (req, reply) => {
      const paramParsed = IdParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        return reply.code(400).send({ error: "INVALID_ID", issues: paramParsed.error.issues });
      }

      const bodyParsed = LeadPatchSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: bodyParsed.error.issues });
      }

      const { id } = paramParsed.data;
      const patch = bodyParsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const actorUserId = BigInt(req.auth!.uid);
      const prisma = getPrisma();

      // Determine expected version: If-Match header takes precedence over body
      const headerVersion = parseVersion(req.headers["if-match"] as string | undefined);
      const bodyVersion = typeof patch.version === "number" ? patch.version : null;
      const expectedVersion = headerVersion ?? bodyVersion ?? null;

      // status field rejection is handled by Zod schema (z.never())

      // Normalize phone fields if provided
      let phoneE164: string | undefined;
      let phoneAlt: string | null | undefined;
      let phoneAlt2: string | null | undefined;

      const countryCode = (patch as Record<string, unknown>)["country_code"] as string | undefined;

      if (patch.phone_e164) {
        try {
          phoneE164 = strictNormalizePhone(patch.phone_e164, countryCode ?? "US");
        } catch (err) {
          if (err instanceof InvalidPhoneError) {
            return reply.code(400).send({ error: "INVALID_PHONE", message: err.message });
          }
          throw err;
        }
      }

      if (patch.phone_alt !== undefined) {
        if (patch.phone_alt === null) {
          phoneAlt = null;
        } else {
          try {
            phoneAlt = normalizePhone(patch.phone_alt, countryCode ?? "US").e164;
          } catch {
            phoneAlt = patch.phone_alt;
          }
        }
      }

      if (patch.phone_alt2 !== undefined) {
        if (patch.phone_alt2 === null) {
          phoneAlt2 = null;
        } else {
          try {
            phoneAlt2 = normalizePhone(patch.phone_alt2, countryCode ?? "US").e164;
          } catch {
            phoneAlt2 = patch.phone_alt2;
          }
        }
      }

      // Build update data (omit version from patch data — we manage it)
      const { version: _v, ...patchData } = patch as Record<string, unknown>;
      void _v;

      const updateData: Record<string, unknown> = {
        ...patchData,
        modifyAt: new Date(),
      };

      if (phoneE164 !== undefined) updateData["phoneE164"] = phoneE164;
      if (phoneAlt !== undefined) updateData["phoneAlt"] = phoneAlt;
      if (phoneAlt2 !== undefined) updateData["phoneAlt2"] = phoneAlt2;

      // Map snake_case to camelCase
      const fieldMap: Record<string, string> = {
        phone_e164: "phoneE164",
        phone_alt: "phoneAlt",
        phone_alt2: "phoneAlt2",
        country_code: "countryCode",
        first_name: "firstName",
        middle_initial: "middleInitial",
        last_name: "lastName",
        address1: "address1",
        address2: "address2",
        postal_code: "postalCode",
        date_of_birth: "dateOfBirth",
        owner_user_id: "ownerUserId",
        vendor_lead_code: "vendorLeadCode",
        source_id: "sourceId",
        custom_data: "customData",
      };

      const mappedData: Record<string, unknown> = { modifyAt: new Date() };
      for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
        if (snakeKey in patchData) {
          let val = patchData[snakeKey];
          if (snakeKey === "date_of_birth" && val) {
            val = new Date(val as string);
          }
          if (snakeKey === "owner_user_id" && val) {
            val = BigInt(val as string | number);
          }
          mappedData[camelKey] = val;
        }
      }

      // Direct passthrough fields
      for (const f of ["title", "city", "state", "email", "gender", "comments", "rank"]) {
        if (f in patchData) mappedData[f] = patchData[f];
      }

      // custom_data deep merge — done at query time
      if ("custom_data" in patchData) {
        // Will merge below after fetching existing
      }

      let after: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        after = await prisma.$transaction(async (tx: any) => {
          const before = await tx.lead.findFirst({
            where: { id, tenantId, deletedAt: null },
          });

          if (!before) {
            const notFound = { __notFound: true };
            return notFound;
          }

          // Check optimistic lock
          if (expectedVersion !== null && before.version !== expectedVersion) {
            return {
              __staleVersion: true,
              expected: expectedVersion,
              actual: before.version,
            };
          }

          // Deep merge custom_data
          if ("custom_data" in patchData && patchData["custom_data"]) {
            const existingCustom = (before.customData as Record<string, unknown>) ?? {};
            const patchCustom = patchData["custom_data"] as Record<string, unknown>;
            mappedData["customData"] = { ...existingCustom, ...patchCustom };
          }

          const updated = await tx.lead.update({
            where: { id, tenantId },
            data: {
              ...mappedData,
              version: { increment: 1 },
            },
          });

          // Compute diff for audit
          const beforeObj = { ...before } as Record<string, unknown>;
          const afterObj = { ...updated } as Record<string, unknown>;
          const patchKeys = Object.keys(mappedData);
          const diff = diffLeadChanges(beforeObj, afterObj, patchKeys);

          await auditLead({
            tx: tx as Parameters<typeof auditLead>[0]["tx"],
            action: "lead.updated",
            tenantId,
            actorUserId,
            entityId: String(id),
            before: diff.before,
            after: diff.after,
            ip: req.ip,
            userAgent: req.headers["user-agent"],
            requestId: req.id,
          });

          return updated;
        }) as Record<string, unknown>;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === "P2025") {
          return reply.code(412).send({
            error: "stale_version",
            message: "Lead modified by another writer; re-fetch and retry.",
          });
        }
        throw err;
      }

      if (after["__notFound"]) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      if (after["__staleVersion"]) {
        return reply.code(412).send({
          error: "stale_version",
          expected: after["expected"],
          actual: after["actual"],
          message: "Lead modified by another writer; re-fetch and retry.",
        });
      }

      // After-commit event publish
      void publishLeadEvent("lead.updated", {
        tenant_id: String(tenantId),
        lead_id: String(after["id"]),
        actor_user_id: String(actorUserId),
        ts: new Date().toISOString(),
        action: "lead.updated",
      });

      return reply
        .header("ETag", `"${after["version"]}"`)
        .code(200)
        .send(serializeLead(after));
    },
  );
}
