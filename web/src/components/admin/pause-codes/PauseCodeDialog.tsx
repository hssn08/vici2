"use client";

// M07 — Dialog shell for pause code create/edit.

import * as React from "react";
import { PauseCodeForm } from "./PauseCodeForm";

interface PauseCodeResponse {
  id: string;
  tenantId: string;
  campaignId: string | null;
  code: string;
  name: string;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PauseCodeDialogProps {
  open: boolean;
  editItem: PauseCodeResponse | null;
  onClose: () => void;
  onSaved: (item: PauseCodeResponse) => void;
}

export function PauseCodeDialog({ open, editItem, onClose, onSaved }: PauseCodeDialogProps): React.ReactElement | null {
  if (!open) return null;

  const title = editItem ? `Edit "${editItem.code}"` : "New pause code";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-code-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="relative z-10 w-full max-w-lg rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="pause-code-dialog-title" className="text-lg font-semibold text-[var(--color-fg)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
            aria-label="Close dialog"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <PauseCodeForm
          editItem={editItem}
          onSaved={onSaved}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
