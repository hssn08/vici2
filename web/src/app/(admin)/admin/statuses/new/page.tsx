// M07 — Admin new status page.
// URL: /admin/statuses/new?campaign=<id>

import { StatusForm } from "@/components/admin/statuses/StatusForm";

export const metadata = { title: "New Status · vici2 Admin" };

export default function NewStatusPage({
  searchParams,
}: {
  searchParams: { campaign?: string };
}): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)] mb-2">
          <a href="/admin/statuses" className="hover:text-[var(--color-fg)]">Statuses</a>
          <span>/</span>
          <span className="text-[var(--color-fg)]">New</span>
        </nav>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">New status</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Create a disposition code. Use campaign = __SYS__ for a global code visible to all campaigns.
        </p>
      </div>
      <StatusForm mode="create" prefillCampaignId={searchParams.campaign} />
    </main>
  );
}
