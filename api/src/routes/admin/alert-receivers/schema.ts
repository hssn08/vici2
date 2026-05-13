// O03 — alert-receivers Zod schemas + response types.

import { z } from "zod";

// ─── Config schemas per kind ──────────────────────────────────────────────────

export const SlackConfigSchema = z.object({
  url: z.string().url("Slack webhook URL must be a valid URL"),
});

export const PagerDutyConfigSchema = z.object({
  routing_key: z.string().min(1, "PagerDuty routing_key is required"),
});

export const WebhookConfigSchema = z.object({
  url: z.string().url("Webhook URL must be a valid URL"),
  secret: z.string().optional(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  headers: z.record(z.string()).optional(),
});

const KindSchema = z.enum(["slack", "pagerduty", "webhook"]);

const SeverityFilterSchema = z
  .string()
  .regex(/^(page|warn|info)(,(page|warn|info))*$/, {
    message: "severity_filter must be a comma-separated list of page, warn, info",
  })
  .default("page,warn,info");

// ─── Create ───────────────────────────────────────────────────────────────────

export const AlertReceiverCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slack"),
    name: z.string().min(1).max(128),
    config: SlackConfigSchema,
    active: z.boolean().default(true),
    severityFilter: SeverityFilterSchema.optional(),
  }),
  z.object({
    kind: z.literal("pagerduty"),
    name: z.string().min(1).max(128),
    config: PagerDutyConfigSchema,
    active: z.boolean().default(true),
    severityFilter: SeverityFilterSchema.optional(),
  }),
  z.object({
    kind: z.literal("webhook"),
    name: z.string().min(1).max(128),
    config: WebhookConfigSchema,
    active: z.boolean().default(true),
    severityFilter: SeverityFilterSchema.optional(),
  }),
]);

// ─── Update (partial) ─────────────────────────────────────────────────────────

export const AlertReceiverUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  config: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
  severityFilter: SeverityFilterSchema.optional(),
});

// ─── List query ───────────────────────────────────────────────────────────────

export const AlertReceiverListQuerySchema = z.object({
  kind: KindSchema.optional(),
  active: z
    .string()
    .transform((v: string) => v === "true")
    .optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default("50"),
  offset: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(0))
    .default("0"),
});

// ─── Response type ────────────────────────────────────────────────────────────

/** Masks sensitive config fields before sending to clients. */
export function maskConfig(
  kind: "slack" | "pagerduty" | "webhook",
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "pagerduty") {
    return { ...config, routing_key: "***" };
  }
  if (kind === "webhook" && config["secret"]) {
    return { ...config, secret: "***" };
  }
  return config;
}

export interface AlertReceiverResponse {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  active: boolean;
  severityFilter: string;
  createdAt: string;
  updatedAt: string;
}
