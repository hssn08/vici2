// N01/N02 — nodemailer transport singleton.
// N02 update: adds html support + RFC 8058 List-Unsubscribe headers.
// Phase 1: plain SMTP. Phase 2: configurable adapter (SES/Postmark).
// SMTP is disabled if VICI2_SMTP_HOST is not set.

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { generateUnsubscribeToken } from "../../lib/unsubscribe.js";

let _transporter: Transporter | null = null;

export function getTransporter(): Transporter | null {
  const host = process.env.VICI2_SMTP_HOST ?? "";
  if (!host) return null; // SMTP not configured — skip silently

  if (!_transporter) {
    const port = parseInt(process.env.VICI2_SMTP_PORT ?? "587", 10);
    const tls = (process.env.VICI2_SMTP_TLS ?? "true").toLowerCase() !== "false";

    _transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: tls && port !== 465,
      auth: {
        user: process.env.VICI2_SMTP_USER ?? "",
        pass: process.env.VICI2_SMTP_PASS ?? "",
      },
    });
  }

  return _transporter;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // N02: for List-Unsubscribe header generation
  notificationId?: string;
  userId?: string;
  tenantId?: string;
  category?: string;
}): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) return false;

  const from = process.env.VICI2_SMTP_FROM ?? "Vici2 <noreply@example.com>";

  // Build List-Unsubscribe headers (RFC 8058) if we have category + userId
  const extraHeaders: Record<string, string> = {};
  if (opts.userId && opts.category) {
    try {
      const baseUrl = process.env.VICI2_APP_BASE_URL ?? "";
      const token = generateUnsubscribeToken(BigInt(opts.userId), opts.category);
      const unsubscribeUrl = `${baseUrl}/api/notifications/unsubscribe?token=${token}`;
      extraHeaders["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
      extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    } catch {
      // Missing secret or other error — skip headers silently
    }
  }

  await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    headers: extraHeaders,
  });
  return true;
}
