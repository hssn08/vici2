// D02 — Auto-detect column mapping heuristic (PLAN §7.2)

interface MappingRow {
  source: string;
  target: string;
  transform?: string;
}

interface AutoDetectRule {
  target: string;
  match: RegExp;
}

export const AUTO_DETECT_RULES: AutoDetectRule[] = [
  { target: "phone_e164",    match: /\b(phone|mobile|cell|tel|telephone|primary[_ ]?phone)\b/i },
  { target: "phone_alt",     match: /\b(alt[_ ]?phone|secondary[_ ]?phone|phone[_ ]?2)\b/i },
  { target: "first_name",    match: /\b(first[_ ]?name|fname|given[_ ]?name)\b/i },
  { target: "last_name",     match: /\b(last[_ ]?name|lname|surname|family[_ ]?name)\b/i },
  { target: "email",         match: /\bemail\b/i },
  { target: "state",         match: /\bstate\b/i },
  { target: "postal_code",   match: /\b(zip|postal[_ ]?code|postcode)\b/i },
  { target: "date_of_birth", match: /\b(dob|birth[_ ]?date|date[_ ]?of[_ ]?birth)\b/i },
  { target: "first_name",    match: /\bfirst\b/i },
  { target: "last_name",     match: /\blast\b/i },
  { target: "address1",      match: /\b(address[_ ]?1?|addr\b|street)\b/i },
  { target: "city",          match: /\bcity\b/i },
  { target: "country_code",  match: /\b(country|country[_ ]?code)\b/i },
  { target: "gender",        match: /\bgender\b/i },
  { target: "comments",      match: /\b(comments?|notes?|memo)\b/i },
  { target: "vendor_lead_code", match: /\b(vendor[_ ]?lead[_ ]?code|vlc|lead[_ ]?id)\b/i },
];

export interface AutoDetectResult {
  target: string;
  confidence: number;
}

/** Auto-detect target column for a single header name. */
export function autoDetectColumn(header: string): AutoDetectResult | null {
  for (const rule of AUTO_DETECT_RULES) {
    const trimmed = header.trim();
    // Exact match (case-insensitive) → confidence 1.0
    if (trimmed.toLowerCase() === rule.target.replace(/_/g, " ").toLowerCase()) {
      return { target: rule.target, confidence: 1.0 };
    }
    // Substring match → confidence 0.9
    if (rule.match.test(trimmed)) {
      return { target: rule.target, confidence: 0.9 };
    }
  }
  return null;
}

/** Auto-detect mapping for all headers. */
export function autoDetectMapping(headers: string[]): {
  rows: MappingRow[];
  autoDetect: Record<string, AutoDetectResult>;
} {
  const rows: MappingRow[] = [];
  const autoDetect: Record<string, AutoDetectResult> = {};
  const usedTargets = new Set<string>();

  for (const header of headers) {
    const detected = autoDetectColumn(header);
    if (detected && !usedTargets.has(detected.target)) {
      usedTargets.add(detected.target);
      autoDetect[header] = detected;
      const transform = detected.target === "phone_e164" || detected.target === "phone_alt"
        ? "phone"
        : detected.target === "email"
        ? "lower"
        : detected.target === "state"
        ? "trim,upper"
        : "trim";
      rows.push({ source: header, target: detected.target, transform });
    }
  }

  return { rows, autoDetect };
}

// Vicidial default mapping preset (PLAN §7.1)
export const VICIDIAL_DEFAULT_MAPPING: MappingRow[] = [
  { source: "phone_number",      target: "phone_e164",    transform: "phone" },
  { source: "first_name",        target: "first_name",    transform: "trim" },
  { source: "last_name",         target: "last_name",     transform: "trim" },
  { source: "state",             target: "state",         transform: "trim,upper" },
  { source: "postal_code",       target: "postal_code",   transform: "trim" },
  { source: "vendor_lead_code",  target: "vendor_lead_code", transform: "trim" },
  { source: "source_id",         target: "source_id",     transform: "trim" },
  { source: "address1",          target: "address1",      transform: "trim" },
  { source: "address2",          target: "address2",      transform: "trim" },
  { source: "city",              target: "city",          transform: "trim" },
  { source: "email",             target: "email",         transform: "lower" },
  { source: "gender",            target: "gender",        transform: "upper" },
  { source: "date_of_birth",     target: "date_of_birth", transform: "date:MM/DD/YYYY" },
  { source: "comments",          target: "comments",      transform: "trim" },
];
