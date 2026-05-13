// M04 — Admin audit log list page.
//
// URL: /admin/audit

import { Suspense } from "react";
import { AuditLogTable } from "@/components/admin/audit/AuditLogTable";

export const metadata = { title: "Audit Log · vici2 Admin" };

export default function AuditLogPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Audit log</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Browse immutable audit events. Click any row to inspect its chain linkage and verify
            integrity.
          </p>
        </div>
        <nav className="flex gap-2" aria-label="Audit sub-navigation">
          <a
            href="/admin/audit/attestations"
            className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Attestations
          </a>
        </nav>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading audit log" className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
                aria-hidden
              />
            ))}
          </div>
        }
      >
        <AuditLogTable />
      </Suspense>
    </main>
  );
}
