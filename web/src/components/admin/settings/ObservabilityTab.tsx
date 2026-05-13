"use client";

// M05 — Observability settings tab.
// Links to alert-receivers (O03) and surfaces a summary of configured receivers.

import * as React from "react";
import { SectionHeading } from "./shared";

export function ObservabilityTab(): React.ReactElement {
  return (
    <div className="space-y-6">
      <SectionHeading>Alert receivers</SectionHeading>

      <p className="text-sm text-[var(--color-fg-muted)]">
        Alert receivers define where system notifications (page-level alerts,
        SLA breaches, DNC sync failures) are delivered. Configure them in the
        dedicated alert-receivers manager.
      </p>

      <a
        href="/admin/alert-receivers"
        className="inline-flex items-center rounded-md px-4 py-2 text-sm font-medium bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)] transition-colors"
        aria-label="Manage alert receivers"
      >
        Manage alert receivers
      </a>

      <SectionHeading>Metrics &amp; monitoring</SectionHeading>

      <div
        className="rounded-md border border-dashed border-[var(--color-fg-muted)] p-6"
        role="note"
      >
        <p className="text-sm text-[var(--color-fg-muted)]">
          Prometheus metrics are available at{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 text-xs font-mono">
            :9101/metrics
          </code>{" "}
          (API server internal port). Grafana dashboard links will appear here
          once O04 ships the monitoring stack.
        </p>
      </div>
    </div>
  );
}
