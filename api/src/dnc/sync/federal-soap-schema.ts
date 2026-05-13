// D05 — Federal DNC SOAP response schemas (PLAN §3.1).
// Validated with zod against captured WSDL responses.

import { z } from "zod";

// ── Login ─────────────────────────────────────────────────────────────────────

export const LoginResponseSchema = z.object({
  strSessionToken: z.string().min(1),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── CanGetChangeFile status codes ─────────────────────────────────────────────

export const ChangeFileStatus = z.enum([
  "RequestCompleted",
  "RequestPending",
  "AlreadyDownloadedToday",
  "NoChanges",
  "Error",
]);
export type ChangeFileStatus = z.infer<typeof ChangeFileStatus>;

export const CanGetChangeFileResponseSchema = z.object({
  strStatus: ChangeFileStatus,
});

// ── GetChangeFile ─────────────────────────────────────────────────────────────

export const GetChangeFileResponseSchema = z.object({
  strPresignedUrl: z.string().url(),
});
export type GetChangeFileResponse = z.infer<typeof GetChangeFileResponseSchema>;

// ── CanGetFullFile ─────────────────────────────────────────────────────────────

export const FullFileStatus = z.enum([
  "RequestCompleted",
  "RequestPending",
  "Error",
]);

export const CanGetFullFileResponseSchema = z.object({
  strStatus: FullFileStatus,
});

// ── GetFullFile ───────────────────────────────────────────────────────────────

export const GetFullFileResponseSchema = z.object({
  strPresignedUrl: z.string().url(),
});

// ── Delta file line ───────────────────────────────────────────────────────────

// Fixed-width: phone_10digit (10) + ' ' + date (YYYY-MM-DD) + ' ' + action (A|D)
const DELTA_LINE_RE = /^(\d{10}) (\d{4}-\d{2}-\d{2}) ([AD])$/;

export interface DeltaLine {
  phone10: string;
  date: string;
  action: "A" | "D";
}

export function parseDeltaLine(line: string): DeltaLine | null {
  const m = DELTA_LINE_RE.exec(line.trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { phone10: m[1], date: m[2], action: m[3] as "A" | "D" };
}
