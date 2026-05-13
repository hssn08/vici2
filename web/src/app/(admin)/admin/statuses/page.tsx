// M07 — Admin statuses list page.
// URL: /admin/statuses

import { Suspense } from "react";
import { PageHeader } from "@/components/admin/shared/PageHeader";
import { TableSkeleton } from "@/components/admin/shared/TableSkeleton";
import { StatusList } from "@/components/admin/statuses/StatusList";

export const metadata = { title: "Statuses · vici2 Admin" };

export default function StatusesPage(): React.ReactElement {
  return (
    <main>
      <PageHeader
        title="Statuses"
        description="Call dispositions per campaign and system-wide defaults."
        actionHref="/admin/statuses/new"
        actionLabel="New status"
      />
      <Suspense fallback={<TableSkeleton rows={8} cols={7} />}>
        <StatusList />
      </Suspense>
    </main>
  );
}
