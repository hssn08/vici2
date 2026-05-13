"use client";

// M07 — Reusable confirmation dialog for destructive actions.

import * as React from "react";
import { Button } from "@/components/ui/button";

interface ConfirmDeleteDialogProps {
  open: boolean;
  title: string;
  description?: string;
  warningMessage?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  loading?: boolean;
}

export function ConfirmDeleteDialog({
  open,
  title,
  description,
  warningMessage,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
  loading = false,
}: ConfirmDeleteDialogProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="relative z-10 w-full max-w-md rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="confirm-delete-title"
          className="text-lg font-semibold text-[var(--color-fg)]"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{description}</p>
        )}
        {warningMessage && (
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3">
            <p className="text-xs text-amber-800">{warningMessage}</p>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className="bg-[var(--color-state-error)] text-white hover:bg-red-700"
          >
            {loading ? "Deleting..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
