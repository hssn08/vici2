"use client";

// M05 — Pacing defaults tab.
// Campaign pacing defaults: dial_method, drop_target_max.
// These are stored in tenants.settings JSON and surfaced as campaign defaults.

import * as React from "react";
import { SelectField, SectionHeading } from "./shared";
import type { DialMethod, TenantSettingsData } from "./types";
import { NumberField } from "./shared";

interface PacingTabProps {
  data: TenantSettingsData;
  onChange: (patch: Partial<PacingState>) => void;
}

export interface PacingState {
  dialMethod: DialMethod;
  dropTargetMax: number;
}

const DIAL_METHOD_LABELS: Record<DialMethod, string> = {
  MANUAL: "Manual — agent dials one at a time",
  RATIO: "Ratio — fixed dial:agent ratio",
  PROGRESSIVE: "Progressive — 1:1 dialing with pacing",
  ADAPT_HARD: "Adaptive Hard — FCC hard cap enforcement",
  ADAPT_AVG: "Adaptive Average — rolling average drop rate",
  ADAPT_TAPERED: "Adaptive Tapered — smooth ramp with taper",
};

export function PacingTab({ data, onChange }: PacingTabProps): React.ReactElement {
  const [state, setState] = React.useState<PacingState>({
    dialMethod: (data.settings.pacingDefaults?.dialMethod as DialMethod) ?? "PROGRESSIVE",
    dropTargetMax: data.settings.pacingDefaults?.dropTargetMax ?? 1.5,
  });

  const update = <K extends keyof PacingState>(k: K, v: PacingState[K]): void => {
    const next = { ...state, [k]: v };
    setState(next);
    onChange(next);
  };

  return (
    <fieldset className="space-y-5 border-0 p-0 m-0">
      <legend className="sr-only">Pacing defaults for new campaigns</legend>

      <SectionHeading>Campaign pacing defaults</SectionHeading>

      <p className="text-sm text-[var(--color-fg-muted)]">
        These values are applied as defaults when creating new campaigns. Each
        campaign can override them individually.
      </p>

      <SelectField
        id="dial-method-default"
        label="Default dial method"
        value={state.dialMethod}
        onChange={(e) => update("dialMethod", e.target.value as DialMethod)}
        hint="The dialing mode pre-selected for new campaigns."
      >
        {(Object.entries(DIAL_METHOD_LABELS) as [DialMethod, string][]).map(
          ([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ),
        )}
      </SelectField>

      <NumberField
        id="drop-target-max"
        label="Default drop target max (%)"
        min={0}
        max={3.0}
        step={0.1}
        value={state.dropTargetMax}
        onChange={(e) =>
          update("dropTargetMax", Math.max(0, Math.min(3.0, Number(e.target.value))))
        }
        hint="FCC TCPA ceiling is 3.00%. Recommended: 1.5%. This is the default for new adaptive campaigns."
        className="max-w-[8rem]"
      />

      <div className="rounded-md bg-yellow-50 p-3 text-xs text-yellow-800" role="note">
        The FCC prohibits drop rates above 3% measured over a rolling 30-day
        period (16 C.F.R. §310.4(b)(4)). The API enforces this ceiling.
      </div>
    </fieldset>
  );
}
