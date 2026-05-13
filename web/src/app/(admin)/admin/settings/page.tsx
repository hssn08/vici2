// M01 — Admin tenant settings page.
// URL: /admin/settings

import { Suspense } from "react";
import { TenantSettingsForm } from "@/components/admin/TenantSettingsForm";

export const metadata = { title: "Settings · vici2 Admin" };

export default function SettingsPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Tenant settings</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Configure system-wide policies for your tenant. Requires{" "}
          <strong>super_admin</strong> role.
        </p>
      </div>

      <div className="max-w-lg">
        <Suspense
          fallback={
            <div role="status" aria-label="Loading settings" className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
                  aria-hidden
                />
              ))}
            </div>
          }
        >
          <TenantSettingsForm />
        </Suspense>
      </div>
    </main>
  );
}
