// Zod schemas for S02 supervisor monitor API.
// S02 PLAN §11.

import { z } from "zod";

// ── POST /api/sup/monitor/start ─────────────────────────────────────────────

export const MonitorStartBodySchema = z.object({
  target_uid: z.number().int().positive(),
  initial_mode: z.enum(["listen", "whisper", "barge"]),
});
export type MonitorStartBody = z.infer<typeof MonitorStartBodySchema>;

export const MonitorStartResponseSchema = z.object({
  session_id: z.string(),
  token: z.string(),
  expires_at: z.string(),
  dial_extension: z.string(),
  target_conf_name: z.string(),
});
export type MonitorStartResponse = z.infer<typeof MonitorStartResponseSchema>;

// ── PATCH /api/sup/sessions/:id/mode ────────────────────────────────────────

export const MonitorModePatchBodySchema = z.object({
  mode: z.enum(["listen", "whisper", "barge"]),
});
export type MonitorModePatchBody = z.infer<typeof MonitorModePatchBodySchema>;

export const MonitorModePatchResponseSchema = z.object({
  session_id: z.string(),
  previous_mode: z.string(),
  mode: z.string(),
  transitioned_at: z.string(),
});
export type MonitorModePatchResponse = z.infer<typeof MonitorModePatchResponseSchema>;

// ── GET /internal/freeswitch/monitor_authz ──────────────────────────────────

export const MonitorAuthzQuerySchema = z.object({
  caller_uid: z.string(),
  target_tid: z.string(),
  target_uid: z.string(),
  mode: z.enum(["listen", "whisper", "barge"]),
  token: z.string(),
});

// ── POST /internal/freeswitch/monitor_end ───────────────────────────────────

export const MonitorEndQuerySchema = z.object({
  uuid: z.string().min(1),
});
