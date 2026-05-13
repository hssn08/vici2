// O03 — Exported pure delivery functions for unit testing.
// These functions are also used by the main alert-delivery worker.

import { createHmac } from "node:crypto";
import type { AlertmanagerAlert } from "../routes/internal/alerts.js";

export interface DeliveryResult {
  httpStatus?: number;
  ok: boolean;
  error?: string;
}

export async function deliverSlack(
  config: Record<string, unknown>,
  alert: AlertmanagerAlert,
  severity: string,
): Promise<DeliveryResult> {
  const url = config["url"] as string;
  if (!url) return { ok: false, error: "slack config missing url" };

  const alertname = alert.labels["alertname"] ?? "Alert";
  const summary = alert.annotations["summary"] ?? "";
  const body = JSON.stringify({
    text: `*[${severity.toUpperCase()}]* ${alertname}`,
    attachments: [
      {
        color: severity === "page" ? "danger" : severity === "warn" ? "warning" : "good",
        fields: [
          { title: "Summary", value: summary || "No summary", short: false },
          { title: "Status", value: alert.status ?? "firing", short: true },
          { title: "Severity", value: severity, short: true },
        ],
      },
    ],
  });

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { httpStatus: resp.status, ok: resp.status === 200 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deliverPagerDuty(
  config: Record<string, unknown>,
  alert: AlertmanagerAlert,
  severity: string,
): Promise<DeliveryResult> {
  const routingKey = config["routing_key"] as string;
  if (!routingKey) return { ok: false, error: "pagerduty config missing routing_key" };

  const alertname = alert.labels["alertname"] ?? "Alert";
  const summary = alert.annotations["summary"] ?? alertname;
  const eventAction = alert.status === "resolved" ? "resolve" : "trigger";
  const dedupKey = alert.fingerprint ?? `${alertname}-${Date.now()}`;

  const pdSeverity =
    severity === "page" ? "critical" : severity === "warn" ? "warning" : "info";

  const body = JSON.stringify({
    routing_key: routingKey,
    event_action: eventAction,
    dedup_key: dedupKey,
    payload: {
      summary,
      severity: pdSeverity,
      source: "vici2-alertmanager",
      custom_details: {
        alertname,
        labels: alert.labels,
        annotations: alert.annotations,
        runbook: alert.annotations["runbook"],
        dashboard: alert.annotations["dashboard"],
      },
    },
  });

  try {
    const resp = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { httpStatus: resp.status, ok: resp.status === 202 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deliverWebhook(
  config: Record<string, unknown>,
  alert: AlertmanagerAlert,
  severity: string,
): Promise<DeliveryResult> {
  const url = config["url"] as string;
  if (!url) return { ok: false, error: "webhook config missing url" };

  const method = (config["method"] as string | undefined) ?? "POST";
  const secret = config["secret"] as string | undefined;
  const extraHeaders = (config["headers"] as Record<string, string> | undefined) ?? {};

  const body = JSON.stringify({ alert, severity, source: "vici2" });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (secret) {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Vici2-Signature"] = `sha256=${sig}`;
  }

  try {
    const resp = await fetch(url, { method, headers, body });
    return {
      httpStatus: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type { AlertDeliveryJobPayload } from "./alert-delivery.js";
