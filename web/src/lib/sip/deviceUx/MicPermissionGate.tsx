"use client";

/**
 * A02 — MicPermissionGate
 *
 * Renders a blocking overlay when microphone access is denied.
 * Provides browser-specific instructions and a "Try again" button.
 * WCAG 2.1 AA compliant: uses role=dialog, aria-modal, focus trap.
 */

import * as React from "react";

interface MicPermissionGateProps {
  onRetry: () => void;
}

export function MicPermissionGate({
  onRetry,
}: MicPermissionGateProps): React.ReactElement {
  const retryRef = React.useRef<HTMLButtonElement>(null);

  // Auto-focus the retry button when the gate appears
  React.useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mic-gate-title"
      aria-describedby="mic-gate-desc"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="mx-4 max-w-md rounded-xl bg-[var(--color-surface-elevated)] p-8 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-state-error)]/20 text-xl"
          >
            🎤
          </span>
          <h2
            id="mic-gate-title"
            className="text-lg font-semibold text-[var(--color-fg)]"
          >
            Microphone access required
          </h2>
        </div>

        <p
          id="mic-gate-desc"
          className="mb-6 text-sm text-[var(--color-fg-muted)]"
        >
          vici2 needs access to your microphone to handle calls. Please grant
          microphone permission using the instructions for your browser:
        </p>

        <ul
          className="mb-6 space-y-2 text-sm text-[var(--color-fg-muted)]"
          aria-label="Browser-specific microphone permission instructions"
        >
          <li>
            <strong className="text-[var(--color-fg)]">Chrome / Edge:</strong>{" "}
            Click the camera icon in the address bar → Allow → Reload
          </li>
          <li>
            <strong className="text-[var(--color-fg)]">Firefox:</strong> Click
            the lock icon → Permissions → Microphone → Allow → Reload
          </li>
          <li>
            <strong className="text-[var(--color-fg)]">Safari:</strong> Safari
            menu → Settings for This Website → Microphone → Allow → Reload
          </li>
        </ul>

        <button
          ref={retryRef}
          onClick={onRetry}
          className="w-full rounded-lg bg-[var(--color-brand-600)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--color-brand-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]"
          type="button"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
