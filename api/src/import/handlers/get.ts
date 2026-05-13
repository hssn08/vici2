// D02 — GET /api/admin/imports/:id (PLAN §5.3)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { getPrisma } from "../../lib/prisma.js";

interface ImportRow {
  id: string;
  tenant_id: bigint;
  list_id: bigint;
  status: string;
  source_key: string;
  errors_key: string | null;
  file_bytes: bigint | null;
  row_count_total: number | null;
  row_count_processed: number;
  row_count_inserted: number;
  row_count_skipped: number;
  row_count_errored: number;
  meta: string;
  error_summary: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  failed_reason: string | null;
  created_at: Date;
}

function importToResponse(row: ImportRow, req: AnyApp): object {
  const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;
  const errorSummary = row.error_summary
    ? (typeof row.error_summary === "string" ? JSON.parse(row.error_summary) : row.error_summary)
    : null;

  return {
    import_id: row.id,
    status: row.status,
    name: meta.name ?? null,
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    row_count_total: row.row_count_total ?? null,
    row_count_processed: row.row_count_processed,
    row_count_inserted: row.row_count_inserted,
    row_count_skipped: row.row_count_skipped,
    row_count_errored: row.row_count_errored,
    summary: errorSummary ? { by_error_code: errorSummary.byCode ?? {} } : null,
    errors_url: row.errors_key
      ? `${req.protocol}://${req.hostname}/api/admin/imports/${row.id}/errors.csv`
      : null,
    failed_reason: row.failed_reason ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export function registerGetImportRoute(app: AnyApp): void {
  app.get(
    "/api/admin/imports/:id",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
    },
    async (req: AnyApp, reply: AnyApp) => {
      const { id } = req.params as { id: string };
      const tenantId = BigInt(req.auth.tenantId);
      const prisma = getPrisma();

      const rows = await prisma.$queryRawUnsafe<ImportRow[]>(
        `SELECT id, tenant_id, list_id, status, source_key, errors_key,
                file_bytes, row_count_total, row_count_processed,
                row_count_inserted, row_count_skipped, row_count_errored,
                meta, error_summary, started_at, completed_at, failed_reason, created_at
         FROM imports
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
        id, tenantId,
      );

      // 404 for cross-tenant (don't leak existence)
      if (!rows || rows.length === 0) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      return reply.send(importToResponse(rows[0]!, req));
    },
  );
}
