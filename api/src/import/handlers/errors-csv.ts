// D02 — GET /api/admin/imports/:id/errors.csv (streaming download) (PLAN §5.1)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { getPrisma } from "../../lib/prisma.js";
import { errorsFilePath, readLocalStream } from "../storage.js";
import { existsSync } from "node:fs";

export function registerErrorsCsvRoute(app: AnyApp): void {
  app.get(
    "/api/admin/imports/:id/errors.csv",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
    },
    async (req: AnyApp, reply: AnyApp) => {
      const { id } = req.params as { id: string };
      const tenantId = BigInt(req.auth.tenantId);
      const prisma = getPrisma();

      // Verify import exists and belongs to tenant
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        errors_key: string | null;
        row_count_errored: number;
      }>>(
        "SELECT id, errors_key, row_count_errored FROM imports WHERE id = ? AND tenant_id = ? LIMIT 1",
        id, tenantId,
      );

      if (!rows || rows.length === 0) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      const importRow = rows[0]!;
      if (!importRow.errors_key || importRow.row_count_errored === 0) {
        return reply.code(404).send({ error: "NO_ERRORS", message: "This import has no errors" });
      }

      const filePath = errorsFilePath(importRow.errors_key);

      if (!existsSync(filePath)) {
        return reply.code(404).send({
          error: "ERRORS_FILE_NOT_FOUND",
          message: "Errors file not yet available or was removed",
        });
      }

      reply.raw.setHeader("Content-Type", "text/csv");
      reply.raw.setHeader(
        "Content-Disposition",
        `attachment; filename="import_${id}_errors.csv"`,
      );

      const stream = readLocalStream(filePath);
      stream.pipe(reply.raw);

      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      return reply;
    },
  );
}
