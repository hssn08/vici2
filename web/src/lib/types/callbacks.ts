// A08 — Callback frontend types and utilities

export type CallbackStatus = "PENDING" | "LIVE" | "DONE" | "DEAD";
export type CallbackScope = "AGENT" | "GLOBAL";

export interface Callback {
  id: string;
  lead_id: string;
  campaign_id: string;
  user_id: string | null;
  scope: CallbackScope;
  callback_at: string; // ISO-8601 UTC
  status: CallbackStatus;
  comments: string | null;
  lead_tz_iana: string | null;
  lead_name?: string; // synthesized: firstName + lastName
  lead_phone?: string; // phoneE164
  created_at: string;
  updated_at: string;
}

export interface DueCallbackData {
  callback_id: string;
  lead_id: string;
  lead_name: string;
  phone: string;
  callback_at: string;
  comments: string | null;
}

export interface TcpaResult {
  allowed: boolean;
  lead_tz_iana?: string;
  hour?: number;
}

// ---------------------------------------------------------------------------
// TCPA window check (8am–9pm lead local time)
// ---------------------------------------------------------------------------

export function isOutsideTcpaWindow(
  isoUtc: string,
  leadTzIana: string | null,
): boolean {
  if (!leadTzIana) return false;
  try {
    const d = new Date(isoUtc);
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: leadTzIana,
      hour: "numeric",
      hour12: false,
    }).format(d);
    const hour = parseInt(hourStr, 10);
    return hour < 8 || hour >= 21;
  } catch {
    return false; // unknown timezone → don't warn
  }
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

export function formatCallbackTime(isoUtc: string, agentTz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: agentTz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(isoUtc));
}

export function formatLeadLocalTime(
  isoUtc: string,
  leadTzIana: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: leadTzIana,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(isoUtc));
}

/** Convert datetime-local string value to ISO-8601 UTC string */
export function localDateTimeToIso(dtLocalValue: string): string {
  return new Date(dtLocalValue).toISOString();
}

/** Format a Date to datetime-local input value (YYYY-MM-DDTHH:mm) */
export function toDateTimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Returns next business day at 10am in local time as a datetime-local string */
export function defaultCallbackTime(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday → Monday
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Saturday → Monday
  d.setHours(10, 0, 0, 0);
  return toDateTimeLocalValue(d);
}

/** Mask phone for display: show only last 4 digits */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  return `•••-••••-${digits.slice(-4)}`;
}

/** Map server error codes to human messages */
export const ERROR_MESSAGES: Record<string, string> = {
  callback_too_soon: "Callback must be at least 5 minutes from now",
  callback_too_far: "Callback cannot be more than 1 year in the future",
  callback_not_found: "This callback no longer exists",
  callback_terminal: "This callback has already been completed or cancelled",
  permission_denied: "You don't have permission to modify this callback",
  lead_not_found: "Lead not found",
  already_claimed: "This callback has already been claimed by another agent",
};

export function mapApiError(code: string): string {
  return ERROR_MESSAGES[code] ?? "An unexpected error occurred";
}
