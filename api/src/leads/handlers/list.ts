// D01 — GET /api/leads (PLAN §1.1, §2)
// List with filters, cursor pagination, optional count.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { LeadListQuerySchema } from "../schemas.js";
import { encodeCursor, decodeCursor, CursorError } from "../cursor.js";
import { isAdmin } from "../permissions.js";
import { serializeLead } from "./get.js";
import { cappedCount } from "../sql/count-capped.sql.js";

// Columns selected in list (custom_data omitted by default)
const LIST_SELECT = {
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
  city: true,
  state: true,
  postalCode: true,
  email: true,
  gender: true,
  rank: true,
  ownerUserId: true,
  calledCount: true,
  lastCalledAt: true,
  knownTimezone: true,
  tzBlocked: true,
  version: true,
  deletedAt: true,
  entryAt: true,
  modifyAt: true,
  createdAt: true,
  updatedAt: true,
  customData: false, // excluded by default
} as const;

const LIST_SELECT_WITH_CUSTOM = { ...LIST_SELECT, customData: true } as const;

export function registerListLeadsRoute(app: FastifyInstance): void {
  app.get(
    "/api/leads",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:read"),
      ],
    },
    async (req, reply) => {
      const qs = req.query as Record<string, string | string[]>;
      const parsed = LeadListQuerySchema.safeParse(qs);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY", issues: parsed.error.issues });
      }

      const q = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const prisma = getPrisma();

      // Build where clause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {
        tenantId,
        ...(q.include_deleted ? {} : { deletedAt: null }),
      };

      if (q.list_id && q.list_id.length > 0) {
        where["listId"] = q.list_id.length === 1 ? q.list_id[0] : { in: q.list_id };
      }
      if (q.status && q.status.length > 0) {
        where["status"] = q.status.length === 1 ? q.status[0] : { in: q.status };
      }
      if (q.owner_user_id) {
        where["ownerUserId"] = q.owner_user_id;
      }
      if (q.phone_e164) {
        where["phoneE164"] = q.phone_e164;
      }
      if (q.state) {
        where["state"] = q.state;
      }
      if (q.min_called !== undefined || q.max_called !== undefined) {
        where["calledCount"] = {
          ...(q.min_called !== undefined ? { gte: q.min_called } : {}),
          ...(q.max_called !== undefined ? { lte: q.max_called } : {}),
        };
      }
      if (q.created_after || q.created_before) {
        where["createdAt"] = {
          ...(q.created_after ? { gte: new Date(q.created_after) } : {}),
          ...(q.created_before ? { lte: new Date(q.created_before) } : {}),
        };
      }
      if (q.modified_after || q.modified_before) {
        where["modifyAt"] = {
          ...(q.modified_after ? { gte: new Date(q.modified_after) } : {}),
          ...(q.modified_before ? { lte: new Date(q.modified_before) } : {}),
        };
      }
      if (q.search) {
        where["OR"] = [
          { lastName: { startsWith: q.search } },
          { firstName: { startsWith: q.search } },
          { email: { startsWith: q.search } },
          { vendorLeadCode: { startsWith: q.search } },
        ];
      }

      // Extract custom field filters from raw query string
      const customFilters: Array<{ key: string; value: string }> = [];
      for (const [k, v] of Object.entries(qs)) {
        if (k.startsWith("custom.")) {
          const fieldKey = k.slice(7);
          if (/^[a-z_][a-z0-9_]{0,30}$/.test(fieldKey)) {
            customFilters.push({ key: fieldKey, value: String(v) });
          }
        }
      }

      // Cursor pagination
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cursorWhere: Record<string, any> = {};
      if (q.cursor) {
        try {
          const decoded = decodeCursor(q.cursor, q.sort);
          if (q.sort === "modify_at_desc") {
            cursorWhere = {
              OR: [
                { modifyAt: { lt: decoded.timestamp } },
                { modifyAt: decoded.timestamp, id: { lt: decoded.id } },
              ],
            };
          } else {
            cursorWhere = {
              OR: [
                { createdAt: { lt: decoded.timestamp } },
                { createdAt: decoded.timestamp, id: { lt: decoded.id } },
              ],
            };
          }
        } catch (err) {
          if (err instanceof CursorError) {
            return reply.code(400).send({ error: err.code, message: err.message });
          }
          throw err;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalWhere: Record<string, any> = {
        AND: [where, cursorWhere],
      };

      const includeCustom =
        q.include?.includes("custom_data") || customFilters.length > 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orderBy: any[] =
        q.sort === "modify_at_desc"
          ? [{ modifyAt: "desc" as const }, { id: "desc" as const }]
          : [{ createdAt: "desc" as const }, { id: "desc" as const }];

      const fetchLimit = q.limit + 1; // fetch one extra to detect has_more

      const leads = await prisma.lead.findMany({
        where: finalWhere,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        select: includeCustom ? LIST_SELECT_WITH_CUSTOM as any : LIST_SELECT as any,
        orderBy,
        take: fetchLimit,
      });

      const hasMore = leads.length > q.limit;
      const pageLeads = hasMore ? leads.slice(0, q.limit) : leads;

      let nextCursor: string | null = null;
      if (hasMore && pageLeads.length > 0) {
        const last = pageLeads[pageLeads.length - 1] as unknown as {
          modifyAt: Date;
          createdAt: Date;
          id: bigint;
        };
        const ts = q.sort === "modify_at_desc" ? last.modifyAt : last.createdAt;
        nextCursor = encodeCursor(ts, last.id, q.sort);
      }

      // withCount — admin only
      let countResult: { count: number; capped?: boolean } | undefined;
      if (q.withCount) {
        if (!isAdmin(req)) {
          return reply.code(403).send({ error: "ADMIN_ONLY", message: "withCount requires admin role" });
        }
        const result = await cappedCount(prisma, tenantId, finalWhere);
        countResult = result;
      }

      return reply.code(200).send({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (pageLeads as any[]).map((l: any) => serializeLead(l as Record<string, unknown>)),
        page: {
          limit: q.limit,
          has_more: hasMore,
          next_cursor: nextCursor,
          ...(countResult
            ? countResult.capped
              ? { count_estimate: countResult.count, count_capped: true }
              : { count: countResult.count }
            : {}),
        },
      });
    },
  );
}
