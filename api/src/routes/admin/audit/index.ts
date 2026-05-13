// M04 — Audit log viewer: Fastify route registration.
//
// Routes:
//   GET /api/admin/audit-log                     audit:view
//   GET /api/admin/audit-log/export              audit:export   (CSV or JSON)
//   GET /api/admin/audit-log/:id                 audit:view
//   GET /api/admin/audit-log/:id/verify          audit:view
//   GET /api/admin/audit-attestations            audit:view
//   GET /api/admin/audit-attestations/:id/verify audit:view

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  AuditLogListQuerySchema,
  AuditLogExportQuerySchema,
  AttestationListQuerySchema,
} from "./schema.js";
import type { AuditLogViewerService } from "./service.js";
import { incRequest, incVerify, incExportBytes } from "./metrics.js";

type AuthReq = FastifyRequest & {
  auth?: {
    uid: number;
    tenantId: number;
    role: string;
    perms: Set<string>;
    jti: string;
  };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error("Unauthenticated"), { statusCode: 401 });
  return auth;
}

function toRbac(auth: NonNullable<AuthReq["auth"]>, requestId: string | undefined, req: FastifyRequest) {
  return {
    userId: BigInt(auth.uid),
    tenantId: BigInt(auth.tenantId),
    permissions: auth.perms,
    requestId,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  };
}

function parseId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw Object.assign(new Error("Invalid id"), { statusCode: 400 });
  return n;
}

 
export async function registerAuditLogRoutes(
  app: any,
  service: AuditLogViewerService,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/admin/audit-log
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-log",
    { preHandler: [app.requireAuth, app.requirePermission("audit:view")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = AuditLogListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const result = await service.listAuditLog(
          parsed.data,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        await incRequest({ endpoint: "list", status: "200" });
        return reply.send(result);
      } catch (err) {
        await incRequest({ endpoint: "list", status: String((err as { statusCode?: number }).statusCode ?? 500) });
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-log/export  (must be before /:id)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-log/export",
    { preHandler: [app.requireAuth, app.requirePermission("audit:export")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = AuditLogExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const { format } = parsed.data;
      const isCSV = format !== "json";
      const contentType = isCSV ? "text/csv" : "application/x-ndjson";
      const ext = isCSV ? "csv" : "ndjson";
      const from = parsed.data.from ?? "start";
      const to = parsed.data.to ?? "end";
      const filename = `audit_log_${from}_${to}.${ext}`;

      reply.raw.setHeader("Content-Type", contentType);
      reply.raw.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      reply.raw.setHeader("Transfer-Encoding", "chunked");

      let totalBytes = 0;
      try {
        const gen = service.exportAuditLog(
          parsed.data,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        for await (const chunk of gen) {
          reply.raw.write(chunk);
          totalBytes += Buffer.byteLength(chunk);
        }
      } finally {
        reply.raw.end();
        await incExportBytes(format, totalBytes);
        await incRequest({ endpoint: "export", status: "200" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-log/:id
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-log/:id",
    { preHandler: [app.requireAuth, app.requirePermission("audit:view")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try {
        id = parseId(params.id);
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "id must be a positive integer" });
      }

      try {
        const result = await service.getAuditLogDetail(
          id,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        if (!result) {
          await incRequest({ endpoint: "detail", status: "404" });
          return reply.code(404).send({ code: "not_found", message: "Audit log row not found" });
        }
        await incRequest({ endpoint: "detail", status: "200" });
        return reply.send(result);
      } catch (err) {
        await incRequest({ endpoint: "detail", status: String((err as { statusCode?: number }).statusCode ?? 500) });
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-log/:id/verify
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-log/:id/verify",
    { preHandler: [app.requireAuth, app.requirePermission("audit:view")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try {
        id = parseId(params.id);
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "id must be a positive integer" });
      }

      try {
        const result = await service.verifyRow(
          id,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        await incVerify({ table: "audit_log", result: result.ok ? "ok" : "fail" });
        await incRequest({ endpoint: "verify_row", status: "200" });
        return reply.send({
          ok: result.ok,
          rowHashRecomputed: result.rowHashRecomputed ?? "",
          rowHashStored: result.rowHashStored ?? "",
          prevRowHashMatches: result.prevRowHashMatches ?? true,
          nextRowPrevHashMatches: result.nextRowPrevHashMatches ?? true,
          merkleAttestationDate: result.merkleAttestationDate ?? null,
          failures: result.failures.map((f) => ({
            ...f,
            tenantId: String(f.tenantId),
            id: f.id != null ? String(f.id) : undefined,
          })),
          rowsChecked: result.rowsChecked,
          daysChecked: result.daysChecked,
          attestationsChecked: result.attestationsChecked,
        });
      } catch (err) {
        await incRequest({ endpoint: "verify_row", status: String((err as { statusCode?: number }).statusCode ?? 500) });
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-attestations
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-attestations",
    { preHandler: [app.requireAuth, app.requirePermission("audit:view")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = AttestationListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const result = await service.listAttestations(
          parsed.data,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        await incRequest({ endpoint: "attestations_list", status: "200" });
        return reply.send(result);
      } catch (err) {
        await incRequest({ endpoint: "attestations_list", status: String((err as { statusCode?: number }).statusCode ?? 500) });
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-attestations/:id/verify
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-attestations/:id/verify",
    { preHandler: [app.requireAuth, app.requirePermission("audit:view")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try {
        id = parseId(params.id);
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "id must be a positive integer" });
      }

      try {
        const result = await service.verifyAttestation(
          id,
          toRbac(auth, (req.headers["x-request-id"] as string) ?? undefined, req),
        );
        if (!result) {
          return reply.code(404).send({ code: "not_found", message: "Attestation not found" });
        }

        const merkleRootMatches =
          !result.failures.some((f) => f.kind === "merkle_root_mismatch");
        const signatureValid =
          !result.failures.some((f) => f.kind === "signature_invalid");

        await incVerify({
          table: "audit_attestation",
          result: result.ok ? "ok" : "fail",
        });
        await incRequest({ endpoint: "verify_attestation", status: "200" });

        return reply.send({
          ok: result.ok,
          merkleRootMatches,
          signatureValid,
          rowsChecked: result.rowsChecked,
          failures: result.failures.map((f) => ({
            ...f,
            tenantId: String(f.tenantId),
            id: f.id != null ? String(f.id) : undefined,
          })),
        });
      } catch (err) {
        await incRequest({ endpoint: "verify_attestation", status: String((err as { statusCode?: number }).statusCode ?? 500) });
        throw err;
      }
    },
  );
}
