// M04 — Audit attestation registry page.
//
// URL: /admin/audit/attestations

import { Suspense } from "react";
import { AttestationTable } from "@/components/admin/audit/AttestationTable";

export const metadata = { title: "Attestations · vici2 Admin" };

export default function AttestationsPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Audit attestations</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Daily Merkle-root attestation records. Verify Merkle root and Ed25519 signature for any
            window.
          </p>
        </div>
        <a
          href="/admin/audit"
          className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
        >
          Audit log
        </a>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading attestations" className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
                aria-hidden
              />
            ))}
          </div>
        }
      >
        <AttestationTable />
      </Suspense>
    </main>
  );
}
