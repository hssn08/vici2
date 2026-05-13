// O03 — Admin alert-receivers CRUD + test-fire routes.
//
// Route map (all require auth + alert:read or alert:configure):
//   GET    /api/admin/alert-receivers           alert:read
//   POST   /api/admin/alert-receivers           alert:configure
//   GET    /api/admin/alert-receivers/:id       alert:read
//   PATCH  /api/admin/alert-receivers/:id       alert:configure
//   DELETE /api/admin/alert-receivers/:id       alert:configure
//   POST   /api/admin/alert-receivers/:id/test  alert:configure

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AlertReceiverKind } from "@prisma/client";
import {
  AlertReceiverCreateSchema,
  AlertReceiverUpdateSchema,
  AlertReceiverListQuerySchema,
} from "./schema.js";
import {
  listReceivers,
  getReceiver,
  createReceiver,
  updateReceiver,
  deleteReceiver,
} from "./service.js";
import { enqueueAlertDelivery } from "../../../workers/alert-delivery.js";
import { audit } from "../../../auth/audit.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function parseId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error("Invalid id");
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminAlertReceiverRoutes(app: any): Promise<void> {
  const prisma = getPrisma();

  // -------------------------------------------------------------------------
  // GET /api/admin/alert-receivers
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/alert-receivers",
    { preHandler: [app.requireAuth, app.requirePermission("alert:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = AlertReceiverListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const { kind, active, limit, offset } = parsed.data;
      const rows = await listReceivers(BigInt(auth.tenantId), {
        kind: kind as AlertReceiverKind | undefined,
        active,
        limit,
        offset,
      });
      return reply.send({ data: rows, count: rows.length });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/alert-receivers
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/alert-receivers",
    { preHandler: [app.requireAuth, app.requirePermission("alert:configure")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = AlertReceiverCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }

      const { kind, name, config, active, severityFilter } = parsed.data;
      const row = await createReceiver(BigInt(auth.tenantId), {
        name,
        kind: kind as AlertReceiverKind,
        config: config as Record<string, unknown>,
        active,
        severityFilter,
      });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: "user",
        action: "alert.receiver.created",
        tenantId: auth.tenantId,
        entityType: "alert_receiver",
        entityId: row.id,
        afterJson: { name: row.name, kind: row.kind, active: row.active },
      });

      return reply.code(201).send(row);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/alert-receivers/:id
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/alert-receivers/:id",
    { preHandler: [app.requireAuth, app.requirePermission("alert:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const id = parseId((req.params as { id: string }).id);
      const row = await getReceiver(BigInt(auth.tenantId), id);
      if (!row) return reply.code(404).send({ code: "not_found" });
      return reply.send(row);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/alert-receivers/:id
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/alert-receivers/:id",
    { preHandler: [app.requireAuth, app.requirePermission("alert:configure")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const id = parseId((req.params as { id: string }).id);
      const parsed = AlertReceiverUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }

      const row = await updateReceiver(BigInt(auth.tenantId), id, {
        name: parsed.data.name,
        config: parsed.data.config as Record<string, unknown> | undefined,
        active: parsed.data.active,
        severityFilter: parsed.data.severityFilter,
      });
      if (!row) return reply.code(404).send({ code: "not_found" });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: "user",
        action: "alert.receiver.updated",
        tenantId: auth.tenantId,
        entityType: "alert_receiver",
        entityId: row.id,
        afterJson: { name: row.name, kind: row.kind, active: row.active },
      });

      return reply.send(row);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/alert-receivers/:id
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/alert-receivers/:id",
    { preHandler: [app.requireAuth, app.requirePermission("alert:configure")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const id = parseId((req.params as { id: string }).id);
      const deleted = await deleteReceiver(BigInt(auth.tenantId), id);
      if (!deleted) return reply.code(404).send({ code: "not_found" });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: "user",
        action: "alert.receiver.deleted",
        tenantId: auth.tenantId,
        entityType: "alert_receiver",
        entityId: String(id),
        afterJson: { action: "soft_delete" },
      });

      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/alert-receivers/:id/test
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/alert-receivers/:id/test",
    { preHandler: [app.requireAuth, app.requirePermission("alert:configure")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const id = parseId((req.params as { id: string }).id);

      const receiver = await prisma.alertReceiver.findFirst({
        where: { id, tenantId: BigInt(auth.tenantId), active: true },
      });
      if (!receiver) return reply.code(404).send({ code: "not_found" });

      const testAlert = {
        labels: {
          alertname: "Vici2TestAlert",
          severity: "warn",
          instance: "test",
        },
        annotations: {
          summary: `Test alert fired from receiver ${receiver.name}`,
          description: "This is a test alert. No action required.",
          runbook: "https://repo/spec/runbooks/oncall.md#Vici2TestAlert",
        },
        status: "firing" as const,
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: `test-${Date.now()}`,
      };

      const jobId = await enqueueAlertDelivery({
        tenantId: auth.tenantId,
        receiverId: receiver.id,
        kind: receiver.kind,
        config: receiver.config as Record<string, unknown>,
        alert: testAlert,
        severity: "warn",
        isTest: true,
      });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: "user",
        action: "alert.receiver.test_fired",
        tenantId: auth.tenantId,
        entityType: "alert_receiver",
        entityId: String(id),
        afterJson: { action: "test_fire", jobId },
      });

      return reply.send({ queued: true, jobId });
    },
  );
}
