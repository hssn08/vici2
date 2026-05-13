// O03 — Alert delivery BullMQ worker + enqueue helper.
//
// Queue:   vici2:queue:alert-delivery
// Retries: 3 attempts, exponential backoff (1s, 2s, 4s).
//
// Per-kind delivery:
//   slack      → POST {config.url}  (Slack incoming webhook)
//   pagerduty  → POST https://events.pagerduty.com/v2/enqueue
//   webhook    → POST {config.url}  with optional HMAC-SHA256 signature
//
// After each terminal outcome (success or final failure) writes audit_log.
// Metrics: vici2_alert_deliveries_total, vici2_alert_delivery_latency_seconds,
//          vici2_alert_delivery_failures_total

import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { getRedis } from "../lib/redis.js";
import { getPrisma } from "../lib/prisma.js";
import client from "prom-client";
import type { AlertmanagerAlert } from "../routes/internal/alerts.js";
import {
  deliverSlack,
  deliverPagerDuty,
  deliverWebhook,
  type DeliveryResult,
} from "./alert-delivery-internals.js";

// ─── Job payload ──────────────────────────────────────────────────────────────

export interface AlertDeliveryJobPayload {
  tenantId: number;
  receiverId: bigint;
  kind: "slack" | "pagerduty" | "webhook";
  config: Record<string, unknown>;
  alert: AlertmanagerAlert;
  severity: string;
  isTest: boolean;
}

// ─── Queue name ───────────────────────────────────────────────────────────────

export const ALERT_DELIVERY_QUEUE = "vici2:queue:alert-delivery";

// ─── Metrics ─────────────────────────────────────────────────────────────────

const deliveriesTotal = new client.Counter({
  name: "vici2_alert_deliveries_total",
  help: "Total alert deliveries attempted per receiver kind and result.",
  labelNames: ["kind", "result"] as const,
});

const deliveryLatency = new client.Histogram({
  name: "vici2_alert_delivery_latency_seconds",
  help: "HTTP latency of alert deliveries per receiver kind.",
  labelNames: ["kind"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const deliveryFailuresTotal = new client.Counter({
  name: "vici2_alert_delivery_failures_total",
  help: "Total failed alert deliveries (all attempts exhausted).",
  labelNames: ["kind"] as const,
});

// ─── Enqueue helper ───────────────────────────────────────────────────────────

let _queue: Queue<AlertDeliveryJobPayload> | null = null;

export function getAlertDeliveryQueue(redis?: Redis): Queue<AlertDeliveryJobPayload> {
  if (_queue) return _queue;
  _queue = new Queue<AlertDeliveryJobPayload>(ALERT_DELIVERY_QUEUE, {
    connection: (redis ?? getRedis()) as unknown as Parameters<typeof Queue>[1]["connection"],
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  });
  return _queue;
}

export async function enqueueAlertDelivery(
  payload: AlertDeliveryJobPayload,
): Promise<string | undefined> {
  const queue = getAlertDeliveryQueue();
  const job = await queue.add("deliver", payload);
  return job.id;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let _worker: Worker<AlertDeliveryJobPayload> | null = null;

export function startAlertDeliveryWorker(redisOverride?: Redis): Worker<AlertDeliveryJobPayload> {
  if (_worker) return _worker;

  const prisma = getPrisma();
  const redis = redisOverride ?? getRedis();

  _worker = new Worker<AlertDeliveryJobPayload>(
    ALERT_DELIVERY_QUEUE,
    async (job: Job<AlertDeliveryJobPayload>) => {
      const { kind, config, alert, severity, receiverId, tenantId, isTest } = job.data;
      const attemptsMade = job.attemptsMade ?? 0;

      const t0 = Date.now();
      let result: DeliveryResult;

      try {
        if (kind === "slack") {
          result = await deliverSlack(config, alert, severity);
        } else if (kind === "pagerduty") {
          result = await deliverPagerDuty(config, alert, severity);
        } else {
          result = await deliverWebhook(config, alert, severity);
        }
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const latencyMs = Date.now() - t0;
      const latencySec = latencyMs / 1000;

      // Record metrics
      deliveriesTotal.inc({ kind, result: result.ok ? "success" : "failed" });
      deliveryLatency.observe({ kind }, latencySec);
      if (!result.ok) {
        deliveryFailuresTotal.inc({ kind });
      }

      // Throw on failure to trigger BullMQ retry
      if (!result.ok) {
        const maxAttempts = job.opts.attempts ?? 3;
        const isFinal = attemptsMade + 1 >= maxAttempts;

        // Audit on final failure only (to avoid audit log spam)
        if (isFinal) {
          prisma.auditLog
            .create({
              data: {
                tenantId: BigInt(tenantId),
                actorUserId: null,
                actorKind: "system",
                action: "alert.delivery_failed",
                entityType: "alert_receiver",
                entityId: String(receiverId),
                afterJson: {
                  kind,
                  alertname: alert.labels["alertname"],
                  severity,
                  attempt: attemptsMade + 1,
                  latencyMs,
                  httpStatus: result.httpStatus,
                  error: result.error,
                  isTest,
                },
                requestId: null,
                ipAddress: null,
                userAgent: null,
                ts: new Date(),
              },
            })
            .catch(() => {});
        }

        throw new Error(
          `Alert delivery failed (${kind}): HTTP ${result.httpStatus ?? "N/A"} — ${result.error ?? "unknown"}`,
        );
      }

      // Success audit
      prisma.auditLog
        .create({
          data: {
            tenantId: BigInt(tenantId),
            actorUserId: null,
            actorKind: "system",
            action: "alert.delivered",
            entityType: "alert_receiver",
            entityId: String(receiverId),
            afterJson: {
              kind,
              alertname: alert.labels["alertname"],
              severity,
              attempt: attemptsMade + 1,
              latencyMs,
              httpStatus: result.httpStatus,
              isTest,
            },
            requestId: null,
            ipAddress: null,
            userAgent: null,
            ts: new Date(),
          },
        })
        .catch(() => {});

      return { ok: true, latencyMs, httpStatus: result.httpStatus };
    },
    {
      connection: redis as unknown as Parameters<typeof Worker>[2]["connection"],
      concurrency: 5,
      lockDuration: 30_000,
    },
  );

  _worker.on("error", (err: Error) => {
    console.error("[alert-delivery worker] error", err);
  });

  return _worker;
}

/** Reset for tests. */
export function _resetWorkerForTests(): void {
  _worker = null;
  _queue = null;
}
