"use client";
// N04 — Sync configuration card

import { useState } from "react";
import type { IntegrationStatus } from "../page";

interface Props {
  integration: IntegrationStatus;
  onSave: (settings: Partial<IntegrationStatus>) => Promise<void>;
}

export function SyncConfigCard({ integration, onSave }: Props): React.ReactElement {
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(integration.syncIntervalMinutes ?? 15);
  const [syncMode, setSyncMode] = useState<"ALL_CONTACTS" | "LIST_ONLY">(integration.syncMode ?? "ALL_CONTACTS");
  const [includeRecordingUrl, setIncludeRecordingUrl] = useState(integration.includeRecordingUrl ?? true);
  const [syncOverwritesManual, setSyncOverwritesManual] = useState(integration.syncOverwritesManual ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave({ syncIntervalMinutes, syncMode, includeRecordingUrl, syncOverwritesManual });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">Sync Configuration</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-2">Sync Mode</label>
          <div className="flex gap-4">
            {(["ALL_CONTACTS", "LIST_ONLY"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value={mode}
                  checked={syncMode === mode}
                  onChange={() => setSyncMode(mode)}
                  className="text-[var(--color-brand-600)]"
                />
                <span className="text-sm text-[var(--color-fg)]">
                  {mode === "ALL_CONTACTS" ? "All Contacts" : "List Members Only"}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Sync Interval (minutes)
          </label>
          <input
            type="number"
            min={5}
            max={1440}
            value={syncIntervalMinutes}
            onChange={(e) => setSyncIntervalMinutes(parseInt(e.target.value, 10))}
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          />
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Minimum: 5 minutes, maximum: 1440 (24 hours)</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">Overwrite manual edits</p>
            <p className="text-xs text-[var(--color-fg-muted)]">When off, HubSpot only fills blank lead fields</p>
          </div>
          <button
            role="switch"
            aria-checked={syncOverwritesManual}
            onClick={() => setSyncOverwritesManual(!syncOverwritesManual)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${syncOverwritesManual ? "bg-[var(--color-brand-600)]" : "bg-gray-300"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${syncOverwritesManual ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">Include recording URL</p>
            <p className="text-xs text-[var(--color-fg-muted)]">Attach call recording link to HubSpot engagement</p>
          </div>
          <button
            role="switch"
            aria-checked={includeRecordingUrl}
            onClick={() => setIncludeRecordingUrl(!includeRecordingUrl)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${includeRecordingUrl ? "bg-[var(--color-brand-600)]" : "bg-gray-300"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${includeRecordingUrl ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : saved ? "Saved!" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
