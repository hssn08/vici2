"use client";

/**
 * web/src/components/recordings/RecordingsFilterBar.tsx
 *
 * Filter bar for the recordings list page.
 * R03 PLAN §3.2.
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { RecordingFilters } from "./types";

interface RecordingsFilterBarProps {
  filters: RecordingFilters;
  onChange: (filters: RecordingFilters) => void;
  onReset: () => void;
  isLoading?: boolean;
}

const LIFECYCLE_STATES = [
  { value: "", label: "Any state" },
  { value: "available",  label: "Available" },
  { value: "uploaded",   label: "Uploaded" },
  { value: "archived",   label: "Archived" },
  { value: "failed",     label: "Failed" },
  { value: "deleted",    label: "Deleted" },
];

const CONSENT_STATUSES = [
  { value: "", label: "Any consent" },
  { value: "prompted_accepted", label: "Accepted" },
  { value: "prompted_declined", label: "Declined" },
  { value: "not_required",      label: "Not required" },
  { value: "assumed",           label: "Assumed" },
  { value: "beep_only",         label: "Beep notified" },
];

export function RecordingsFilterBar({
  filters,
  onChange,
  onReset,
  isLoading,
}: RecordingsFilterBarProps): React.ReactElement {
  function set<K extends keyof RecordingFilters>(key: K, value: RecordingFilters[K]): void {
    onChange({ ...filters, [key]: value || undefined });
  }

  const hasActiveFilters = Object.values(filters).some((v) => v !== undefined && v !== "");

  return (
    <div className="flex flex-wrap gap-3 rounded-lg border bg-[var(--color-surface-elevated)] p-4">
      {/* Date range */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">From</label>
        <Input
          type="date"
          className="w-38"
          value={filters.date_from ?? ""}
          onChange={(e) => set("date_from", e.target.value)}
          disabled={isLoading}
        />
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">To</label>
        <Input
          type="date"
          className="w-38"
          value={filters.date_to ?? ""}
          onChange={(e) => set("date_to", e.target.value)}
          disabled={isLoading}
        />
      </div>

      {/* Campaign ID */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Campaign&nbsp;ID</label>
        <Input
          type="number"
          placeholder="e.g. 42"
          className="w-24"
          value={filters.campaign_id ?? ""}
          onChange={(e) => set("campaign_id", e.target.value)}
          disabled={isLoading}
        />
      </div>

      {/* Agent ID */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Agent&nbsp;ID</label>
        <Input
          type="number"
          placeholder="e.g. 7"
          className="w-24"
          value={filters.agent_id ?? ""}
          onChange={(e) => set("agent_id", e.target.value)}
          disabled={isLoading}
        />
      </div>

      {/* Lead phone last4 */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Phone&nbsp;last4</label>
        <Input
          type="text"
          placeholder="1234"
          maxLength={4}
          className="w-20"
          value={filters.lead_phone_last4 ?? ""}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, "").slice(0, 4);
            set("lead_phone_last4", val || undefined);
          }}
          disabled={isLoading}
        />
      </div>

      {/* Call UUID */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">UUID</label>
        <Input
          type="text"
          placeholder="8a3e1c4f-…"
          className="w-44"
          value={filters.call_uuid ?? ""}
          onChange={(e) => set("call_uuid", e.target.value.trim())}
          disabled={isLoading}
        />
      </div>

      {/* Lifecycle state */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">State</label>
        <select
          className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
          value={filters.lifecycle_state ?? ""}
          onChange={(e) => set("lifecycle_state", e.target.value || undefined)}
          disabled={isLoading}
        >
          {LIFECYCLE_STATES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Consent status */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Consent</label>
        <select
          className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
          value={filters.consent_status ?? ""}
          onChange={(e) => set("consent_status", e.target.value || undefined)}
          disabled={isLoading}
        >
          {CONSENT_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Has transcript toggle */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Transcript</label>
        <select
          className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
          value={filters.has_transcript ?? ""}
          onChange={(e) => set("has_transcript", (e.target.value as '' | 'true' | 'false') || undefined)}
          disabled={isLoading}
        >
          <option value="">Any</option>
          <option value="true">Has transcript</option>
          <option value="false">No transcript</option>
        </select>
      </div>

      {/* Has legal hold toggle */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">Legal&nbsp;hold</label>
        <select
          className="h-9 rounded-md border bg-[var(--color-surface)] px-3 text-sm"
          value={filters.has_legal_hold ?? ""}
          onChange={(e) => set("has_legal_hold", (e.target.value as '' | 'true' | 'false') || undefined)}
          disabled={isLoading}
        >
          <option value="">Any</option>
          <option value="true">Under legal hold</option>
          <option value="false">No hold</option>
        </select>
      </div>

      {/* Reset */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={isLoading}
          className="ml-auto"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
