// N01/N02 — BullMQ email delivery processor.
// N02 update: calls renderEmail() from the email-template service;
// falls back to plain-text job.data.body on TemplateNotFoundError.
// Idempotency: DB notification row is the source of truth; duplicates are
// handled by the job.id dedup in BullMQ (jobId = notificationId:attempt).

import type { Job } from "bullmq";
import pino from "pino";
import client from "prom-client";
import { PrismaClient } from "@prisma/client";
import { sendMail } from "./mailer.js";
import { renderEmail, TemplateNotFoundError } from "../../lib/email-render.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "email-delivery" },
});

const emailDeliveryTotal = new client.Counter({
  name: "vici2_n01_email_delivery_total",
  help: "Total email delivery attempts by outcome",
  labelNames: ["outcome"] as const,
});

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}

export interface EmailJobData {
  // Existing N01 fields (unchanged — fallback if template not found)
  notificationId: string;
  tenantId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  idempotencyKey?: string;
  // N02 additions (optional for backward compat)
  category?: string;
  vars?: Record<string, unknown>;
  userPreferredLang?: string;
  isTestSend?: boolean;
}

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { notificationId, to } = job.data;

  logger.info({ notificationId, to, attempt: job.attemptsMade }, "n01:email: processing");

  let finalSubject: string = job.data.subject;
  let finalHtml: string | undefined;
  let finalText: string = job.data.body;

  // N02: attempt template render if category is provided
  if (job.data.category && job.data.tenantId) {
    const prisma = getPrisma();
    const lang = job.data.userPreferredLang ?? "en";
    const vars = job.data.vars ?? {};

    try {
      const rendered = await renderEmail(
        prisma,
        BigInt(job.data.tenantId),
        job.data.category,
        lang,
        vars,
      );
      finalSubject = rendered.subject;
      finalHtml = rendered.html;
      finalText = rendered.text;
    } catch (err) {
      if (err instanceof TemplateNotFoundError) {
        // Fall back to plain-text body from notification row
        logger.warn(
          { category: job.data.category, lang, notificationId },
          "n01:email: template not found; falling back to plain text",
        );
      } else {
        emailDeliveryTotal.inc({ outcome: "failed" });
        logger.error({ err, notificationId, to }, "n01:email: render error");
        throw err; // let BullMQ retry
      }
    }
  }

  try {
    const sent = await sendMail({
      to,
      subject: finalSubject,
      text: finalText,
      html: finalHtml,
      notificationId,
      userId: job.data.userId,
      tenantId: job.data.tenantId,
      category: job.data.category,
    });

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
