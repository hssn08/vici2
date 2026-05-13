// S03 — Admin scripts list page.
// URL: /admin/scripts

import { Suspense } from "react";
import { ScriptList } from "@/components/admin/ScriptList";

export const metadata = { title: "Scripts · vici2 Admin" };

export default function ScriptsPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Scripts</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage call scripts with variable interpolation and version history.
          </p>
        </div>
        <a
          href="/admin/scripts/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          New script
        </a>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading scripts" className="space-y-2">
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
        <ScriptList />
      </Suspense>
    </main>
  );
}
