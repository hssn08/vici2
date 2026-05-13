// M06 — Admin create-carrier page.
// URL: /admin/carriers/new

import { CarrierForm } from "@/components/admin/CarrierForm";

export const metadata = { title: "New Carrier · vici2 Admin" };

export default function NewCarrierPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <li><a href="/admin/carriers" className="hover:underline">Carriers</a></li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="text-[var(--color-fg)]">New carrier</li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">Create carrier</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Add a BYOC SIP carrier. Credentials are encrypted at rest. Requires super_admin role.
        </p>
      </div>

      <div className="max-w-2xl">
        <CarrierForm mode="create" />
      </div>
    </main>
  );
}
