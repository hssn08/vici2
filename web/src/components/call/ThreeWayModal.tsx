"use client";

import * as React from "react";
import { useThreeWay } from "@/lib/hooks/useThreeWay";

interface ThreeWayModalProps {
  onClose: () => void;
}

export function ThreeWayModal({ onClose }: ThreeWayModalProps): React.ReactElement {
  const { originate, loading, error } = useThreeWay();
  const [phone, setPhone] = React.useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;
    await originate(phone.trim());
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="3-way conference"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-96 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">3-Way Conference</h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label htmlFor="threeway-phone" className="mb-1 block text-sm font-medium">
              Add phone number
            </label>
            <input
              id="threeway-phone"
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
              {loading ? "Calling…" : "Originate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
