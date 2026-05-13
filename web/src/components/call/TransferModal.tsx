"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

interface TransferModalProps {
  onClose: () => void;
}

function isValidPhone(value: string): boolean {
  // Allow E.164 or common formats; basic validation
  return /^\+?[\d\s\-().]{7,20}$/.test(value.trim());
}

export function TransferModal({ onClose }: TransferModalProps): React.ReactElement {
  const callUuid = useCallStore((s) => s.callUuid);
  const clearCall = useCallStore((s) => s.clearCall);
  const [phone, setPhone] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidPhone(phone)) { setError("Enter a valid phone number"); return; }
    if (!callUuid) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/agent/call/${callUuid}/transfer`, {
        method: "POST",
        body: { kind: "blind", dest: phone.trim() },
      });
      clearCall();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Blind transfer"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-96 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Blind Transfer</h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label htmlFor="transfer-phone" className="mb-1 block text-sm font-medium">
              Transfer to phone number
            </label>
            <input
              id="transfer-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 000-0000"
              autoFocus
              className="w-full rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
            {error && (
              <p role="alert" className="mt-1 text-xs text-[var(--color-state-error)]">{error}</p>
            )}
          </div>

          {/* Phase 2 options (disabled) */}
          <div className="space-y-1 text-sm text-[var(--color-fg-muted)]">
            <div className="flex items-center gap-2 opacity-40 cursor-not-allowed" title="Coming in Phase 2">
              <input type="radio" disabled />
              <span>Warm transfer</span>
            </div>
            <div className="flex items-center gap-2 opacity-40 cursor-not-allowed" title="Coming in Phase 2">
              <input type="radio" disabled />
              <span>Closer / agent group</span>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !phone}
              aria-disabled={loading || !phone}
              className="rounded bg-[var(--color-brand-600)] px-4 py-2 text-sm text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
            >
              {loading ? "Transferring…" : "Transfer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
