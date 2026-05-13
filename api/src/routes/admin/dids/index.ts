// M06 — Admin DID number route registration.
//
// Route map:
//   GET    /api/admin/dids                admin+   list DIDs (filter ?carrier=X)
//   POST   /api/admin/dids                admin+   create single DID
//   GET    /api/admin/dids/:id            admin+   get one DID
//   PATCH  /api/admin/dids/:id            admin+   update DID
//   DELETE /api/admin/dids/:id            admin+   delete DID
//   POST   /api/admin/dids/bulk           admin+   CSV bulk import

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  DidCreateSchema,
  DidUpdateSchema,
  DidListQuerySchema,
  DidBulkRowSchema,
} from "./schema.js";
import {
  listDids,
  getDid,
  createDid,
  updateDid,
  deleteDid,
  parseCsvRows,
  bulkImportDids,
} from "./service.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function parseId(raw: unknown, name = "id"): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error(`Invalid ${name}`);
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminDidRoutes(app: any): Promise<void> {
  // NOTE: /bulk must be registered before /:id to avoid being matched as an id route
  // POST /api/admin/dids/bulk
  app.post(
    "/api/admin/dids/bulk",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);

      // Accept JSON body with { csv: "<csv text>" } or raw CSV text
      let csvText = "";
      const body = req.body as Record<string, unknown>;

      if (body && typeof body.csv === "string") {
        csvText = body.csv;
      } else if (typeof req.body === "string") {
        csvText = req.body;
      } else {
        return reply.code(400).send({ code: "invalid_body", message: "Provide { csv: '<csv text>' } or raw CSV body" });
      }

      if (!csvText.trim()) {
        return reply.code(400).send({ code: "empty_csv", message: "CSV content is empty" });
      }

      const rawRows = parseCsvRows(csvText);
      if (rawRows.length === 0) {
        return reply.code(400).send({ code: "no_rows", message: "No data rows found in CSV" });
      }
      if (rawRows.length > 10000) {
        return reply.code(400).send({ code: "too_many_rows", message: "Maximum 10,000 rows per upload" });
      }

      // Validate each row
      const validRows = [];
      const rowErrors: Array<{ row: number; message: string }> = [];

      for (let i = 0; i < rawRows.length; i++) {
        const parsed = DidBulkRowSchema.safeParse(rawRows[i]);
        if (!parsed.success) {
          rowErrors.push({ row: i + 2, message: parsed.error.message });
        } else {
          validRows.push(parsed.data);
        }
      }

      if (validRows.length === 0) {
        return reply.code(400).send({
          code: "all_rows_invalid",
          message: "All rows failed validation",
          errors: rowErrors,
        });
      }

      const result = await bulkImportDids(auth.tenantId, auth.uid, validRows);
      return reply.code(result.errors.length > 0 ? 207 : 200).send({
        ...result,
        errors: [...rowErrors, ...result.errors],
      });
    },
  );

  // GET /api/admin/dids
  app.get(
    "/api/admin/dids",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = DidListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listDids(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // POST /api/admin/dids
  app.post(
    "/api/admin/dids",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = DidCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const did = await createDid(auth.tenantId, auth.uid, parsed.data);
        return reply.code(201).send(did);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A DID with this E.164 number already exists" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/dids/:id
  app.get(
    "/api/admin/dids/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let didId: bigint;
      try { didId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid DID ID" });
      }
      const did = await getDid(auth.tenantId, didId);
      if (!did) return reply.code(404).send({ code: "not_found", message: "DID not found" });
      return reply.send(did);
    },
  );

  // PATCH /api/admin/dids/:id
  app.patch(
    "/api/admin/dids/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let didId: bigint;
      try { didId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid DID ID" });
      }
      const parsed = DidUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const updated = await updateDid(auth.tenantId, auth.uid, didId, parsed.data);
      if (!updated) return reply.code(404).send({ code: "not_found", message: "DID not found" });
      return reply.send(updated);
    },
  );

  // DELETE /api/admin/dids/:id
  app.delete(
    "/api/admin/dids/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let didId: bigint;
      try { didId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid DID ID" });
      }
      const deleted = await deleteDid(auth.tenantId, auth.uid, didId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "DID not found" });
      return reply.code(204).send();
    },
  );
}
