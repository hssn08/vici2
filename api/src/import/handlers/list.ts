// D02 — GET /api/admin/imports (cursor-paginated) (PLAN §5.1)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { getPrisma } from "../../lib/prisma.js";
import { ListImportsQuerySchema } from "../schemas.js";

export function registerListImportsRoute(app: AnyApp): void {
  app.get(
    "/api/admin/imports",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
    },
    async (req: AnyApp, reply: AnyApp) => {
      const tenantId = BigInt(req.auth.tenantId);
      const prisma = getPrisma();

      const parsed = ListImportsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY", issues: parsed.error.issues });
      }

      const { cursor, limit, list_id, status } = parsed.data;

      interface ImportRow {
        id: string;
        tenant_id: bigint;
        list_id: bigint;
        status: string;
        row_count_processed: number;
        row_count_inserted: number;
        row_count_skipped: number;
        row_count_errored: number;
        meta: string;
        started_at: Date | null;
        completed_at: Date | null;
        created_at: Date;
        errors_key: string | null;
      }

      // Build WHERE clause
      const conditions: string[] = ["tenant_id = ?"];
      const params: unknown[] = [tenantId];

      if (cursor) {
        conditions.push("created_at < (SELECT created_at FROM imports WHERE id = ? LIMIT 1)");
        params.push(cursor);
      }
      if (list_id) {
        conditions.push("list_id = ?");
        params.push(list_id);
      }
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }

      params.push(limit + 1);  // +1 to detect next page

      const rows = await prisma.$queryRawUnsafe<ImportRow[]>(
        `SELECT id, tenant_id, list_id, status, row_count_processed,
                row_count_inserted, row_count_skipped, row_count_errored,
                meta, started_at, completed_at, created_at, errors_key
         FROM imports
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
        ...params,
      );

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row: ImportRow) => {
        const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;
        return {
          import_id: row.id,
          list_id: String(row.list_id),
          status: row.status,
          name: meta.name ?? null,
          row_count_processed: row.row_count_processed,
          row_count_inserted: row.row_count_inserted,
          row_count_skipped: row.row_count_skipped,
          row_count_errored: row.row_count_errored,
          started_at: row.started_at?.toISOString() ?? null,
          completed_at: row.completed_at?.toISOString() ?? null,
          created_at: row.created_at.toISOString(),
          errors_url: row.errors_key
            ? `/api/admin/imports/${row.id}/errors.csv`
            : null,
        };
      });

      const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.import_id : null;

      return reply.send({
        items,
        next_cursor: nextCursor,
        has_more: hasMore,
      });
    },
  );
}
