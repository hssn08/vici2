// M06 — Admin create-DID page.
// URL: /admin/dids/new

import { DidForm } from "@/components/admin/DidForm";

export const metadata = { title: "New DID · vici2 Admin" };

export default function NewDidPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <li><a href="/admin/dids" className="hover:underline">DIDs</a></li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="text-[var(--color-fg)]">New DID</li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">Add DID</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Add a new inbound DID number and configure its routing.
        </p>
      </div>

      <div className="max-w-2xl">
        <DidForm mode="create" />
      </div>
    </main>
  );
}
