// M05 — Unified settings panel page.
// URL: /admin/settings
//
// Replaces the M01 single-form settings page with a multi-tab panel covering
// General, Auth, Compliance, Telephony, Observability, and Pacing categories.
// RBAC: GET requires tenant:read (admin+); PATCH requires tenant:edit (super_admin).

import { Suspense } from "react";
import { SettingsPanel } from "@/components/admin/settings/SettingsPanel";

export const metadata = { title: "Settings · vici2 Admin" };

export default function SettingsPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Tenant settings</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Configure system-wide policies for your tenant.{" "}
          <strong>super_admin</strong> role is required to save changes to
          authentication policy. Other categories require <strong>admin</strong>.
        </p>
      </div>

      <div className="max-w-2xl">
        <Suspense
          fallback={
            <div role="status" aria-label="Loading settings" className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
                  aria-hidden
                />
              ))}
            </div>
          }
        >
          <SettingsPanel />
        </Suspense>
      </div>
    </main>
  );
}
