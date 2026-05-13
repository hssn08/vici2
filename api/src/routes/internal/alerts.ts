// O03 — Internal alerts webhook endpoint.
//
// Receives Alertmanager v4 webhook payloads and fans out to enabled
// alert_receivers per tenant via BullMQ (vici2:queue:alert-delivery).
//
// Route:
//   POST /internal/alerts/webhook
//
// Protected by X-Internal-Secret header (same pattern as I01 queue routes).
//
// Alertmanager webhook payload shape (subset we care about):
//   {
//     receiver: string;
//     status: "firing" | "resolved";
//     alerts: AlertmanagerAlert[];
//     commonLabels: Record<string, string>;
//     commonAnnotations: Record<string, string>;
//     version: "4";
//   }

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { enqueueAlertDelivery } from "../../workers/alert-delivery.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AlertSchema = z.object({
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  status: z.enum(["firing", "resolved"]).default("firing"),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});

export type AlertmanagerAlert = z.infer<typeof AlertSchema>;

const AlertmanagerWebhookPayloadSchema = z.object({
  receiver: z.string().optional(),
  status: z.enum(["firing", "resolved"]).default("firing"),
  alerts: z.array(AlertSchema).default([]),
  commonLabels: z.record(z.string()).default({}),
  commonAnnotations: z.record(z.string()).default({}),
  version: z.string().optional(),
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().optional(),
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireInternalSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = req.headers["x-internal-secret"];
  const expected =
    (env as Record<string, unknown>)["internalSecret"] as string | undefined ??
    process.env.INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    reply.code(403).send({ code: "forbidden" });
    return false;
  }
  return true;
}

// ─── Severity routing ─────────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set(["page", "warn", "info"]);

function extractSeverity(alert: AlertmanagerAlert): string {
  const sev = alert.labels["severity"] ?? "warn";
  return VALID_SEVERITIES.has(sev) ? sev : "warn";
}

// ─── Route registration ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerInternalAlertsRoutes(app: any): Promise<void> {
  const prisma = getPrisma();

  // POST /internal/alerts/webhook
  // Accepts Alertmanager webhook payload, fans out to enabled receivers.
  app.post(
    "/internal/alerts/webhook",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const parsed = AlertmanagerWebhookPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "validation_error",
          message: parsed.error.message,
        });
      }

      const payload = parsed.data;
      const tenantId = 1n; // Phase 1: single tenant

      // Load active receivers for tenant
      const receivers = await prisma.alertReceiver.findMany({
        where: { tenantId, active: true },
      });

      let totalQueued = 0;

      for (const alert of payload.alerts) {
        const severity = extractSeverity(alert);
        const alertname = alert.labels["alertname"] ?? "unknown";

        // Audit: every Alertmanager receipt (action matches AuditAction union)
        // Fire-and-forget; do not block the response
        prisma.auditLog
          .create({
            data: {
              tenantId,
              actorUserId: null,
              actorKind: "system",
              action: "alert.received" as string,
              entityType: "alert",
              entityId: alertname,
              afterJson: {
                severity,
                status: alert.status ?? payload.status,
                fingerprint: alert.fingerprint,
                labels: alert.labels,
                annotations: alert.annotations,
                receiver: payload.receiver,
              },
              requestId: null,
              ipAddress: req.ip ?? null,
              userAgent: null,
              ts: new Date(),
            },
          })
          .catch((err: unknown) => {
            req.log?.warn({ err }, "alert.received audit write failed");
          });

        // Skip info-severity alerts (no delivery)
        if (severity === "info") continue;

        // Fan out to matching receivers
        for (const receiver of receivers) {
          const allowedSeverities = receiver.severityFilter
            .split(",")
            .map((s) => s.trim());
          if (!allowedSeverities.includes(severity)) continue;

          await enqueueAlertDelivery({
            tenantId: Number(tenantId),
            receiverId: receiver.id,
            kind: receiver.kind,
            config: receiver.config as Record<string, unknown>,
            alert,
            severity,
            isTest: false,
          });
          totalQueued++;
        }
      }

      return reply.code(200).send({ queued: totalQueued });
    },
  );
}
