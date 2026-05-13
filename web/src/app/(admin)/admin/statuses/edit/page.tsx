// M07 — Admin edit status page.
// URL: /admin/statuses/edit?campaign=<campaignId>&code=<statusCode>

import { StatusForm } from "@/components/admin/statuses/StatusForm";

export const metadata = { title: "Edit Status · vici2 Admin" };

export default function EditStatusPage({
  searchParams,
}: {
  searchParams: { campaign?: string; code?: string };
}): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)] mb-2">
          <a href="/admin/statuses" className="hover:text-[var(--color-fg)]">Statuses</a>
          <span>/</span>
          <span className="text-[var(--color-fg)]">Edit</span>
        </nav>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Edit status</h1>
      </div>
      <StatusForm
        mode="edit"
        prefillCampaignId={searchParams.campaign}
        prefillCode={searchParams.code}
      />
    </main>
  );
}
