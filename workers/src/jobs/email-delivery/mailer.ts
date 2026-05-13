// N01 — nodemailer transport singleton.
// Phase 1: plain SMTP. Phase 2: configurable adapter (SES/Postmark).
// SMTP is disabled if VICI2_SMTP_HOST is not set.

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

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
}): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) return false;

  const from = process.env.VICI2_SMTP_FROM ?? "Vici2 <noreply@example.com>";
  await transporter.sendMail({ from, to: opts.to, subject: opts.subject, text: opts.text });
  return true;
}
