// N01 — BullMQ email delivery processor.
// Idempotency: DB notification row is the source of truth; duplicates are
// handled by the job.id dedup in BullMQ (jobId = notificationId:attempt).

import type { Job } from "bullmq";
import pino from "pino";
import client from "prom-client";
import { sendMail } from "./mailer.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "email-delivery" },
});

const emailDeliveryTotal = new client.Counter({
  name: "vici2_n01_email_delivery_total",
  help: "Total email delivery attempts by outcome",
  labelNames: ["outcome"] as const,
});

export interface EmailJobData {
  notificationId: string;
  tenantId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
}

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { notificationId, to, subject, body } = job.data;

  logger.info({ notificationId, to, attempt: job.attemptsMade }, "n01:email: processing");

  try {
    const sent = await sendMail({ to, subject, text: body });

    if (sent) {
      emailDeliveryTotal.inc({ outcome: "sent" });
      logger.info({ notificationId, to }, "n01:email: delivered");
    } else {
      // SMTP not configured — soft skip, don't retry
      logger.warn({ notificationId }, "n01:email: SMTP not configured; skipping");
      emailDeliveryTotal.inc({ outcome: "skipped" });
    }
  } catch (err) {
    emailDeliveryTotal.inc({ outcome: "failed" });
    logger.error({ err, notificationId, to, attempt: job.attemptsMade }, "n01:email: delivery failed");
    // Re-throw so BullMQ retries
    throw err;
  }
}
