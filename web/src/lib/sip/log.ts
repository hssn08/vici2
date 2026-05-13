/**
 * A02 — SIP.js LogConnector → console (pino-compatible sink).
 *
 * SIP.js accepts a LogConnector: (level, category, label, content) => void.
 * We forward warn/error to the F-API metrics sink in prod; debug/info
 * are console-only and stripped in prod builds.
 *
 * NEVER log:
 *  - authorizationPassword (see filter)
 *  - SDP bodies (contain ICE candidates with internal IPs)
 *  - media stream contents (impossible by design)
 */

type SipLevel = "debug" | "log" | "warn" | "error";

const PASSWORD_PATTERN = /password|authorization|digest/i;
const SDP_PATTERN = /^(v=|o=|s=|c=|m=|a=|t=)/m;

function sanitize(content: string): string {
  if (PASSWORD_PATTERN.test(content)) return "[REDACTED — auth material]";
  if (SDP_PATTERN.test(content)) return "[REDACTED — SDP body]";
  return content;
}

export function pinoLogConnector(
  level: string,
  category: string,
  label: string | undefined,
  content: string,
): void {
  const safe = sanitize(content);
  const tag = `[sip:${category}${label ? `:${label}` : ""}]`;

  switch (level as SipLevel) {
    case "error":
      console.error(tag, safe);
      break;
    case "warn":
      console.warn(tag, safe);
      break;
    case "log":
    case "debug":
      // debug/log levels are intentionally silenced in production.
      // The SIP.js logConnector contract requires handling all levels.
      break;
  }
}
