// M06 — Admin carriers list page.
// URL: /admin/carriers

import { Suspense } from "react";
import { CarrierTable } from "@/components/admin/CarrierTable";

export const metadata = { title: "Carriers · vici2 Admin" };

export default function CarriersPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Carriers</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage BYOC SIP carriers, credentials, and gateway configuration.
          </p>
        </div>
        <a
          href="/admin/carriers/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          Add carrier
        </a>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading carriers" className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--color-surface-muted)]" aria-hidden />
            ))}
          </div>
        }
      >
        <CarrierTable />
      </Suspense>
    </main>
  );
}
