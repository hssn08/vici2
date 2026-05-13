/**
 * A02 — Park extension helper (FROZEN signature).
 *
 * Substitutes {tid} and {uid} in NEXT_PUBLIC_AGENT_PARK_PATTERN.
 * Default pattern: "*9{tid}_{uid}" → calls T03 dialplan extension
 * which joins the agent's conference agent_t<tid>_u<uid>@default.
 *
 * If T03 PLAN deviates (e.g. picks a different extension), the
 * NEXT_PUBLIC_AGENT_PARK_PATTERN env var alone is changed; no code change.
 *
 * @example
 *   parkExtFor(1, 1042) === "*91_1042"
 */
export function parkExtFor(tenantId: number, userId: number): string {
  const tmpl =
    process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN ?? "*9{tid}_{uid}";
  return tmpl
    .replace("{tid}", String(tenantId))
    .replace("{uid}", String(userId));
}

/**
 * Conference name for the agent's own conference (RFC-002 canonical).
 * agent_t<tenant_id>_u<user_id>@default
 */
export function confNameFor(tenantId: number, userId: number): string {
  return `agent_t${tenantId}_u${userId}@default`;
}
