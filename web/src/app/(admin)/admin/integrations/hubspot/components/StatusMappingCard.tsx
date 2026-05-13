"use client";
// N04 — Disposition → HubSpot call status mapping card

import { useState } from "react";

const HS_STATUSES = ["COMPLETED", "NO_ANSWER", "BUSY", "VOICEMAIL_LEFT", "FAILED", "CANCELED"] as const;
const DEFAULT_DISPOSITIONS = ["SALE", "NI", "NA", "B", "AM", "CALLBK", "DNC", "XFER"];
const DEFAULT_MAP: Record<string, string> = {
  SALE: "COMPLETED", NI: "COMPLETED", NA: "NO_ANSWER",
  B: "BUSY", AM: "VOICEMAIL_LEFT", CALLBK: "COMPLETED",
  DNC: "COMPLETED", XFER: "COMPLETED",
};

interface Props {
  dispositionMap: Record<string, string>;
  onSave: (map: Record<string, string>) => void;
}

export function StatusMappingCard({ dispositionMap, onSave }: Props): React.ReactElement {
  const [localMap, setLocalMap] = useState<Record<string, string>>({ ...DEFAULT_MAP, ...dispositionMap });
  const [saving, setSaving] = useState(false);

  const handleChange = (dispo: string, status: string) => {
    setLocalMap((prev) => ({ ...prev, [dispo]: status }));
  };

  const handleSave = async () => {
    setSaving(true);
    onSave(localMap);
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">Disposition → HubSpot Status Mapping</h2>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            <th className="py-2 pr-4 text-left font-medium text-[var(--color-fg-muted)]">vici2 Disposition</th>
            <th className="py-2 text-left font-medium text-[var(--color-fg-muted)]">HubSpot Call Status</th>
          </tr>
        </thead>
        <tbody>
          {DEFAULT_DISPOSITIONS.map((dispo) => (
            <tr key={dispo} className="border-b border-[var(--color-border)] last:border-0">
              <td className="py-2 pr-4 font-mono text-xs text-[var(--color-fg)]">{dispo}</td>
              <td className="py-2">
                <select
                  value={localMap[dispo] ?? "COMPLETED"}
                  onChange={(e) => handleChange(dispo, e.target.value)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)]"
                >
                  {HS_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : "Save Mapping"}
        </button>
      </div>
    </div>
  );
}
