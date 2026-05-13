// M07 — Variable reference sidebar with insert buttons.

import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Token vocabulary
// ---------------------------------------------------------------------------

const TOKEN_GROUPS: Array<{
  heading: string;
  tokens: Array<{ token: string; description: string }>;
}> = [
  {
    heading: "Lead fields",
    tokens: [
      { token: "{{lead.first_name}}", description: "Lead's first name" },
      { token: "{{lead.last_name}}", description: "Lead's last name" },
      { token: "{{lead.phone}}", description: "Phone (E.164)" },
      { token: "{{lead.phone_alt}}", description: "Alt phone" },
      { token: "{{lead.email}}", description: "Email address" },
      { token: "{{lead.address1}}", description: "Street address line 1" },
      { token: "{{lead.address2}}", description: "Street address line 2" },
      { token: "{{lead.city}}", description: "City" },
      { token: "{{lead.state}}", description: "State (2-letter)" },
      { token: "{{lead.postal_code}}", description: "Postal/ZIP code" },
      { token: "{{lead.country_code}}", description: "Country code (US, CA...)" },
      { token: "{{lead.title}}", description: "Title (Mr, Dr, etc.)" },
      { token: "{{lead.middle_initial}}", description: "Middle initial" },
      { token: "{{lead.gender}}", description: "Gender (M/F/U)" },
      { token: "{{lead.date_of_birth}}", description: "Date of birth" },
      { token: "{{lead.vendor_lead_code}}", description: "Vendor lead code" },
      { token: "{{lead.source_id}}", description: "Source ID" },
      { token: "{{lead.comments}}", description: "Comments/notes" },
      { token: "{{lead.custom.FIELD}}", description: "Custom data field (replace FIELD)" },
    ],
  },
  {
    heading: "Agent fields",
    tokens: [
      { token: "{{agent.name}}", description: "Agent full name" },
      { token: "{{agent.username}}", description: "Agent login username" },
    ],
  },
  {
    heading: "Campaign fields",
    tokens: [
      { token: "{{campaign.name}}", description: "Campaign name" },
    ],
  },
  {
    heading: "Call fields",
    tokens: [
      { token: "{{call.uuid}}", description: "Unique call identifier" },
      { token: "{{call.duration}}", description: "Call duration (MM:SS)" },
      { token: "{{call.start_time}}", description: "Call start time (ISO 8601)" },
    ],
  },
  {
    heading: "Tenant fields",
    tokens: [
      { token: "{{tenant.name}}", description: "Tenant/company name" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlaceholderMenuProps {
  onInsert: (token: string) => void;
  detectedTokens?: string[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlaceholderMenu({ onInsert, detectedTokens = [] }: PlaceholderMenuProps): React.ReactElement {
  return (
    <aside
      aria-label="Variable reference"
      className="space-y-4 overflow-y-auto"
    >
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">Variable reference</h2>
      <p className="text-xs text-[var(--color-fg-muted)]">
        Click to insert at cursor position.
      </p>

      {TOKEN_GROUPS.map(({ heading, tokens }) => (
        <div key={heading} className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
            {heading}
          </h3>
          {tokens.map(({ token, description }) => (
            <button
              key={token}
              type="button"
              onClick={() => onInsert(token)}
              className={cn(
                "w-full rounded border border-[var(--color-border)] px-2 py-1.5",
                "text-left text-xs transition-colors",
                "hover:border-[var(--color-brand-600)] hover:bg-[var(--color-brand-50)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
              )}
              aria-label={`Insert ${token} — ${description}`}
              title={description}
            >
              <span className="font-mono text-[var(--color-brand-600)] break-all">{token}</span>
            </button>
          ))}
        </div>
      ))}

      {detectedTokens.length > 0 && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
          <p className="mb-2 text-xs font-semibold text-[var(--color-fg)]">
            Detected in body ({detectedTokens.length})
          </p>
          <div className="space-y-1">
            {detectedTokens.map((t) => (
              <div key={t} className="flex items-center gap-1 font-mono text-xs text-[var(--color-fg-muted)]">
                <span className="text-green-500">✓</span>
                {t}
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
