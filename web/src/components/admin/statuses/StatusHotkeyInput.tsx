"use client";

// M07 — Single-char hotkey input with live conflict detection.

import * as React from "react";
import { apiFetch } from "@/lib/api";

interface StatusHotkeyInputProps {
  value: string;
  onChange: (value: string) => void;
  campaignId: string;
  excludeStatusCode?: string; // current status code to exclude from conflict check (edit mode)
  disabled?: boolean;
  id?: string;
}

interface StatusResponse {
  data: Array<{ status: string; hotkey: string | null }>;
}

export function StatusHotkeyInput({
  value,
  onChange,
  campaignId,
  excludeStatusCode,
  disabled = false,
  id,
}: StatusHotkeyInputProps): React.ReactElement {
  const [conflict, setConflict] = React.useState<string | null>(null);
  const checkTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  function scheduleCheck(hotkey: string) {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    if (!hotkey || !campaignId) {
      setConflict(null);
      return;
    }
    checkTimerRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch<StatusResponse>(
          `/api/admin/statuses?campaignId=${encodeURIComponent(campaignId)}&pageSize=200`,
        );
        const conflicting = res.data.find(
          (s) =>
            s.hotkey === hotkey &&
            s.status !== excludeStatusCode,
        );
        setConflict(conflicting ? conflicting.status : null);
      } catch {
        // ignore check errors
      }
    }, 400);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.slice(-1); // only last char
    onChange(v);
    scheduleCheck(v);
  }

  return (
    <div className="space-y-1">
      <input
        id={id}
        type="text"
        value={value}
        onChange={handleChange}
        disabled={disabled}
        maxLength={1}
        placeholder="—"
        className={[
          "w-16 rounded-md border px-3 py-2 text-center text-sm font-mono",
          "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
          conflict
            ? "border-[var(--color-state-error)] bg-red-50"
            : "border-[var(--color-border)] bg-[var(--color-surface)]",
          disabled ? "opacity-60 cursor-not-allowed" : "",
        ].join(" ")}
        aria-label="Hotkey — single character"
        aria-invalid={!!conflict}
        aria-describedby={conflict ? "hotkey-conflict-msg" : undefined}
      />
      {conflict && (
        <p id="hotkey-conflict-msg" className="text-xs text-[var(--color-state-error)]">
          Hotkey already used by status {conflict} in this campaign.
        </p>
      )}
    </div>
  );
}
