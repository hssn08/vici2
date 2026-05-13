// S03 — Script variable interpolation engine.
//
// Frozen variable vocabulary:
//   {lead.first_name}       lead.firstName
//   {lead.last_name}        lead.lastName
//   {lead.phone_formatted}  lead.phoneE164 formatted as national number
//   {lead.email}            lead.email
//   {lead.city}             lead.city
//   {lead.state}            lead.state
//   {lead.custom.X}         lead.customData[X]  (JSON field)
//   {agent.name}            user.fullName ?? user.username
//   {campaign.name}         campaign.name
//   {call.duration}         MM:SS derived from call_started_at
//
// Unknown tokens are replaced with "" in render mode; preserved in preview mode.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadContext {
  firstName?: string | null;
  lastName?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  customData?: Record<string, unknown> | null;
}

export interface AgentContext {
  name: string;
}

export interface CampaignContext {
  name: string;
}

export interface CallContext {
  startedAt?: Date | string | null;
}

export interface InterpolateOptions {
  /** In render mode unknown tokens → ""; in preview mode they are preserved. */
  mode?: "render" | "preview";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple HTML-escape for values injected into HTML bodies. */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format a phone number from E.164 to a human-readable national format.
 * Falls back to raw input on parse failure (no throw).
 */
function formatPhone(e164: string): string {
  try {
    // Lazy-import to avoid loading libphonenumber-js at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parsePhoneNumberFromString } = require("libphonenumber-js/min") as {
      parsePhoneNumberFromString: (n: string, c?: string) => { formatNational(): string } | undefined;
    };
    const parsed = parsePhoneNumberFromString(e164, "US");
    return parsed ? parsed.formatNational() : e164;
  } catch {
    return e164;
  }
}

/**
 * Format elapsed seconds as MM:SS.
 */
function formatDuration(startedAt: Date | string | null | undefined): string {
  if (!startedAt) return "00:00";
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (isNaN(start.getTime())) return "00:00";
  const elapsed = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Core interpolation
// ---------------------------------------------------------------------------

/**
 * Replace `{token}` placeholders in `body` using the provided context objects.
 *
 * @param body      The HTML body (may contain {token} placeholders)
 * @param lead      Lead field values
 * @param agent     Agent info
 * @param campaign  Campaign info
 * @param call      Call metadata (start time for duration)
 * @param opts      Options: mode defaults to "render"
 * @returns         HTML string with tokens replaced
 */
export function interpolate(
  body: string,
  lead: LeadContext = {},
  agent: AgentContext = { name: "" },
  campaign: CampaignContext = { name: "" },
  call: CallContext = {},
  opts: InterpolateOptions = {},
): string {
  const mode = opts.mode ?? "render";

  // Build a lookup of known tokens → values (HTML-escaped)
  const known = new Map<string, string>();

  known.set("lead.first_name", escapeHtml(lead.firstName ?? ""));
  known.set("lead.last_name", escapeHtml(lead.lastName ?? ""));
  known.set(
    "lead.phone_formatted",
    escapeHtml(lead.phoneE164 ? formatPhone(lead.phoneE164) : ""),
  );
  known.set("lead.email", escapeHtml(lead.email ?? ""));
  known.set("lead.city", escapeHtml(lead.city ?? ""));
  known.set("lead.state", escapeHtml(lead.state ?? ""));
  known.set("agent.name", escapeHtml(agent.name ?? ""));
  known.set("campaign.name", escapeHtml(campaign.name ?? ""));
  known.set("call.duration", escapeHtml(formatDuration(call.startedAt)));

  // Pre-build custom field entries so we don't iterate inside the replacer
  const customData: Record<string, unknown> =
    (lead.customData && typeof lead.customData === "object"
      ? lead.customData
      : {}) as Record<string, unknown>;

  return body.replace(/\{([a-z][a-z0-9_.]*)\}/gi, (_match: string, token: string) => {
    const lower = token.toLowerCase();

    // Check known tokens
    if (known.has(lower)) return known.get(lower)!;

    // Check lead.custom.* tokens
    if (lower.startsWith("lead.custom.")) {
      const key = lower.slice("lead.custom.".length);
      const val = customData[key];
      if (val !== undefined && val !== null) {
        return escapeHtml(String(val));
      }
      return mode === "render" ? "" : `{${token}}`;
    }

    // Unknown token
    return mode === "render" ? "" : `{${token}}`;
  });
}

// ---------------------------------------------------------------------------
// Convenience: extract declared variable names from a body string
// ---------------------------------------------------------------------------

/** Returns unique token names found in body, e.g. ["lead.first_name", "campaign.name"] */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\{([a-z][a-z0-9_.]*)\}/gi)) {
    const token = match[1];
    if (token) found.add(token.toLowerCase());
  }
  return [...found].sort();
}
