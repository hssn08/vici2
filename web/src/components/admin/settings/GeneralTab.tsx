"use client";

// M05 — General settings tab.
// Fields: tenant name, brand label, report timezone, support email.

import * as React from "react";
import { TextField, SectionHeading } from "./shared";
import type { TenantSettingsData } from "./types";

interface GeneralTabProps {
  data: TenantSettingsData;
  onChange: (patch: Partial<GeneralState>) => void;
}

export interface GeneralState {
  name: string;
  brandLabel: string;
  reportTimezone: string;
  supportEmail: string;
}

export function GeneralTab({ data, onChange }: GeneralTabProps): React.ReactElement {
  const [state, setState] = React.useState<GeneralState>({
    name: data.name,
    brandLabel: data.settings.brandLabel ?? "",
    reportTimezone: data.settings.reportTimezone ?? "",
    supportEmail: data.settings.supportEmail ?? "",
  });

  const update = <K extends keyof GeneralState>(k: K, v: GeneralState[K]): void => {
    const next = { ...state, [k]: v };
    setState(next);
    onChange(next);
  };

  return (
    <fieldset className="space-y-5 border-0 p-0 m-0">
      <legend className="sr-only">General settings</legend>
      <SectionHeading>Identity</SectionHeading>

      <TextField
        id="tenant-name"
        label="Tenant name"
        value={state.name}
        onChange={(e) => update("name", e.target.value)}
        placeholder="My Company"
        aria-label="Tenant display name"
        maxLength={128}
      />

      <TextField
        id="brand-label"
        label="Brand label"
        value={state.brandLabel}
        onChange={(e) => update("brandLabel", e.target.value)}
        placeholder="Shown in admin sidebar"
        hint="Short label displayed in the admin UI header (max 64 characters)."
        maxLength={64}
      />

      <div className="space-y-1">
        <label
          htmlFor="slug-readonly"
          className="block text-sm font-medium text-[var(--color-fg-muted)]"
        >
          Slug (read-only)
        </label>
        <input
          id="slug-readonly"
          type="text"
          value={data.slug}
          readOnly
          disabled
          aria-readonly="true"
          className="h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm opacity-60 cursor-not-allowed"
        />
      </div>

      <SectionHeading>Localization</SectionHeading>

      <TextField
        id="report-timezone"
        label="Report timezone"
        value={state.reportTimezone}
        onChange={(e) => update("reportTimezone", e.target.value)}
        placeholder="America/New_York"
        hint="IANA timezone identifier used for scheduled reports and date display (e.g. America/Chicago)."
      />

      <SectionHeading>Contact</SectionHeading>

      <TextField
        id="support-email"
        label="Support email"
        type="email"
        value={state.supportEmail}
        onChange={(e) => update("supportEmail", e.target.value)}
        placeholder="support@example.com"
        hint="Shown to agents in the help footer. Leave blank to hide."
      />
    </fieldset>
  );
}
