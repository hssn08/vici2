// D01 — GET /api/leads/export (PLAN §1.1)
// Streaming CSV export. RBAC gate here; D02 owns column selection logic.
// This handler ships the streaming pipeline + auth.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { LeadListQuerySchema } from "../schemas.js";

const CSV_COLUMNS = [
  "id",
  "list_id",
  "status",
  "phone_e164",
  "phone_alt",
  "phone_alt2",
  "first_name",
  "last_name",
  "email",
  "state",
  "postal_code",
  "country_code",
  "vendor_lead_code",
  "rank",
  "called_count",
  "known_timezone",
  "entry_at",
  "modify_at",
];

function escapeCSV(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function registerExportLeadsRoute(app: FastifyInstance): void {
  app.get(
    "/api/leads/export",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:export"),
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = {
        tenantId,
        deletedAt: null,
      };

      if (q.list_id && q.list_id.length > 0) {
        where["listId"] = q.list_id.length === 1 ? q.list_id[0] : { in: q.list_id };
      }
      if (q.status && q.status.length > 0) {
        where["status"] = q.status.length === 1 ? q.status[0] : { in: q.status };
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="leads-export-${Date.now()}.csv"`,
        "Transfer-Encoding": "chunked",
      });

      // Write header
      reply.raw.write(CSV_COLUMNS.join(",") + "\n");

      // Stream in batches
      const batchSize = 500;
      let lastId: bigint | null = null;
      let _rowCount = 0; // tracked for D02/audit enrichment

      while (true) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const batch: any[] = await prisma.lead.findMany({
          where: {
            ...where,
            ...(lastId ? { id: { gt: lastId } } : {}),
          },
          select: {
            id: true,
            listId: true,
            status: true,
            phoneE164: true,
            phoneAlt: true,
            phoneAlt2: true,
            firstName: true,
            lastName: true,
            email: true,
            state: true,
            postalCode: true,
            countryCode: true,
            vendorLeadCode: true,
            rank: true,
            calledCount: true,
            knownTimezone: true,
            entryAt: true,
            modifyAt: true,
          },
          orderBy: { id: "asc" },
          take: batchSize,
        });

        if (batch.length === 0) break;

        for (const row of batch) {
          const csvRow = [
            String(row.id),
            String(row.listId),
            row.status,
            row.phoneE164,
            row.phoneAlt ?? "",
            row.phoneAlt2 ?? "",
            row.firstName ?? "",
            row.lastName ?? "",
            row.email ?? "",
            row.state ?? "",
            row.postalCode ?? "",
            row.countryCode,
            row.vendorLeadCode ?? "",
            String(row.rank),
            String(row.calledCount),
            row.knownTimezone ?? "",
            row.entryAt.toISOString(),
            row.modifyAt.toISOString(),
          ]
            .map(escapeCSV)
            .join(",");

          reply.raw.write(csvRow + "\n");
          _rowCount++; // tracked for audit (D02 enriches)
        }

        lastId = (batch[batch.length - 1] as { id: bigint }).id;
        if (batch.length < batchSize) break;
      }

      reply.raw.end();
    },
  );
}
