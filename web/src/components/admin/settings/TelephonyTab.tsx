"use client";

// M05 — Telephony settings tab.
// Phase 1: informational placeholder for telephony defaults.
// Default carrier, caller_id, and max concurrent calls are managed at the
// carrier/DID level in M02 (Carrier admin). This tab surfaces them in Phase 2.

import * as React from "react";
import { SectionHeading } from "./shared";

export function TelephonyTab(): React.ReactElement {
  return (
    <div className="space-y-6">
      <SectionHeading>Telephony defaults</SectionHeading>

      <div
        className="rounded-md border border-dashed border-[var(--color-fg-muted)] p-6 text-center"
        role="note"
        aria-label="Telephony settings placeholder"
      >
        <p className="text-sm font-medium text-[var(--color-fg)]">
          Carrier &amp; DID management
        </p>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Default carrier, caller ID, and concurrency limits are configured in the{" "}
          <strong>Carriers</strong> and <strong>DIDs</strong> sections. Per-tenant
          defaults will be surfaced here in Phase 2.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <a
            href="/admin/carriers"
            className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium bg-[var(--color-surface-muted)] text-[var(--color-fg)] hover:bg-[var(--color-surface-elevated)] border transition-colors"
          >
            Go to Carriers
          </a>
          <a
            href="/admin/dids"
            className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium bg-[var(--color-surface-muted)] text-[var(--color-fg)] hover:bg-[var(--color-surface-elevated)] border transition-colors"
          >
            Go to DIDs
          </a>
        </div>
      </div>
    </div>
  );
}
