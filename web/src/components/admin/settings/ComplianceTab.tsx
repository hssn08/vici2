"use client";

// M05 — Compliance settings tab.
// Fields: recording consent mode (C02), DNC retention years (D05),
// TCPA unknown_tz_policy default, default caller state.

import * as React from "react";
import { NumberField, SelectField, TextField, SectionHeading } from "./shared";
import type { ConsentMode, UnknownTzPolicy, TenantSettingsData } from "./types";

interface ComplianceTabProps {
  data: TenantSettingsData;
  onChange: (patch: Partial<ComplianceState>) => void;
}

export interface ComplianceState {
  consentMinimumMode: ConsentMode;
  internalDncRetentionYears: number;
  unknownTzPolicyDefault: UnknownTzPolicy;
  defaultCallerState: string;
  recordingConsentDefault: boolean;
  allowCallTimeOverrides: boolean;
}

export function ComplianceTab({ data, onChange }: ComplianceTabProps): React.ReactElement {
  const [state, setState] = React.useState<ComplianceState>({
    consentMinimumMode: (data.consentMinimumMode as ConsentMode) ?? "PROMPT_MESSAGE",
    internalDncRetentionYears: data.internalDncRetentionYears,
    unknownTzPolicyDefault:
      (data.settings.unknownTzPolicyDefault as UnknownTzPolicy) ?? "deny",
    defaultCallerState: data.defaultCallerState ?? "",
    recordingConsentDefault: data.settings.recordingConsentDefault ?? false,
    allowCallTimeOverrides: data.settings.allowCallTimeOverrides ?? false,
  });

  const update = <K extends keyof ComplianceState>(k: K, v: ComplianceState[K]): void => {
    const next = { ...state, [k]: v };
    setState(next);
    onChange(next);
  };

  return (
    <fieldset className="space-y-5 border-0 p-0 m-0">
      <legend className="sr-only">Compliance and policy settings</legend>

      <SectionHeading>Recording consent</SectionHeading>

      <SelectField
        id="consent-mode"
        label="Tenant minimum consent mode"
        value={state.consentMinimumMode}
        onChange={(e) =>
          update("consentMinimumMode", e.target.value as ConsentMode)
        }
        hint="Sets the floor for all campaigns. Individual campaigns may be stricter but not looser."
      >
        <option value="PROMPT_MESSAGE">
          PROMPT_MESSAGE — play consent notice, continue recording
        </option>
        <option value="REQUIRE_ACTIVE">
          REQUIRE_ACTIVE — require explicit consent before recording
        </option>
        <option value="SKIP">SKIP — never record</option>
      </SelectField>

      <div className="space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.recordingConsentDefault}
            onChange={(e) => update("recordingConsentDefault", e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border"
            aria-label="Require recording consent on new campaigns by default"
          />
          <span className="text-sm text-[var(--color-fg)]">
            <span className="font-medium">Recording consent required by default</span>
            <br />
            <span className="text-[var(--color-fg-muted)]">
              New campaigns will default to requiring prior express written consent.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.allowCallTimeOverrides}
            onChange={(e) => update("allowCallTimeOverrides", e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border"
            aria-label="Allow call time overrides per campaign"
          />
          <span className="text-sm text-[var(--color-fg)]">
            <span className="font-medium">Allow per-campaign call time overrides</span>
            <br />
            <span className="text-[var(--color-fg-muted)]">
              Admins can set state-specific calling windows on individual campaigns.
            </span>
          </span>
        </label>
      </div>

      <SectionHeading>TCPA / calling rules</SectionHeading>

      <SelectField
        id="unknown-tz-policy"
        label="Unknown timezone policy (default for new campaigns)"
        value={state.unknownTzPolicyDefault}
        onChange={(e) =>
          update("unknownTzPolicyDefault", e.target.value as UnknownTzPolicy)
        }
        hint="What to do when a lead's timezone cannot be resolved. deny = skip the lead; warn_pass = log warning and continue."
      >
        <option value="deny">deny — skip leads with unknown timezone</option>
        <option value="warn_pass">warn_pass — log warning, continue dialing</option>
      </SelectField>

      <TextField
        id="default-caller-state"
        label="Default caller state"
        value={state.defaultCallerState}
        onChange={(e) => update("defaultCallerState", e.target.value.toUpperCase())}
        placeholder="TX"
        maxLength={2}
        hint="2-letter US state code for the dialer's outbound caller location. Used by consent strictest-state-wins logic. Leave blank to disable."
        className="max-w-[6rem] uppercase"
      />

      <SectionHeading>DNC retention</SectionHeading>

      <NumberField
        id="dnc-retention"
        label="Internal DNC retention (years)"
        min={5}
        max={99}
        value={state.internalDncRetentionYears}
        onChange={(e) =>
          update(
            "internalDncRetentionYears",
            Math.max(5, Math.min(99, Number(e.target.value))),
          )
        }
        hint="FCC floor is 5 years (47 C.F.R. §64.1200(d)(6)). Set to 99 for indefinite retention."
        className="max-w-[8rem]"
      />
    </fieldset>
  );
}
