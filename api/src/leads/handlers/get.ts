// D01 — GET /api/leads/:id (PLAN §1.1)
// Returns a single lead. 404 for any miss (intentional: don't leak cross-tenant existence).

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { IdParamSchema } from "../schemas.js";

// Default selected columns (excludes custom_data by default in get we always include it)
const LEAD_SELECT = {
  id: true,
  tenantId: true,
  listId: true,
  status: true,
  vendorLeadCode: true,
  sourceId: true,
  phoneE164: true,
  phoneAlt: true,
  phoneAlt2: true,
  countryCode: true,
  title: true,
  firstName: true,
  middleInitial: true,
  lastName: true,
  address1: true,
  address2: true,
  city: true,
  state: true,
  postalCode: true,
  email: true,
  dateOfBirth: true,
  gender: true,
  comments: true,
  rank: true,
  ownerUserId: true,
  customData: true,
  calledCount: true,
  lastCalledAt: true,
  tzOffsetMin: true,
  knownTimezone: true,
  tzBlocked: true,
  version: true,
  deletedAt: true,
  entryAt: true,
  modifyAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function registerGetLeadRoute(app: FastifyInstance): void {
  app.get(
    "/api/leads/:id",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:read"),
      ],
    },
    async (req, reply) => {
      const parsed = IdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_ID", issues: parsed.error.issues });
      }

      const { id } = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const prisma = getPrisma();

      const lead = await prisma.lead.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: LEAD_SELECT,
      });

      if (!lead) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      // Parse expand param for optional relation loading
      const expandStr = (req.query as Record<string, string>)["expand"] ?? "";
      const expands = expandStr ? expandStr.split(",").map((s) => s.trim()) : [];

      let listData: { id: bigint; name: string } | null = null;
      if (expands.includes("list")) {
        listData = await prisma.list.findFirst({
          where: { id: lead.listId, tenantId },
          select: { id: true, name: true },
        });
      }

      const body = {
        ...serializeLead(lead),
        ...(expands.includes("list") ? { list: listData ? serializeList(listData) : null } : {}),
      };

      return reply
        .header("ETag", `"${lead.version}"`)
        .code(200)
        .send(body);
    },
  );
}

export function serializeLead(lead: Record<string, unknown>): Record<string, unknown> {
  return {
    ...lead,
    id: String(lead["id"]),
    tenantId: String(lead["tenantId"]),
    listId: String(lead["listId"]),
    ownerUserId: lead["ownerUserId"] ? String(lead["ownerUserId"]) : null,
    dateOfBirth: lead["dateOfBirth"]
      ? (lead["dateOfBirth"] as Date).toISOString().slice(0, 10)
      : null,
    entryAt: (lead["entryAt"] as Date).toISOString(),
    modifyAt: (lead["modifyAt"] as Date).toISOString(),
    createdAt: (lead["createdAt"] as Date).toISOString(),
    updatedAt: (lead["updatedAt"] as Date).toISOString(),
    lastCalledAt: lead["lastCalledAt"] ? (lead["lastCalledAt"] as Date).toISOString() : null,
    deletedAt: lead["deletedAt"] ? (lead["deletedAt"] as Date).toISOString() : null,
  };
}

function serializeList(list: { id: bigint; name: string }): Record<string, unknown> {
  return { id: String(list.id), name: list.name };
}
