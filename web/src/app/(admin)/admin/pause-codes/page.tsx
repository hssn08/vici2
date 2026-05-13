// M07 — Admin pause codes list page.
// URL: /admin/pause-codes

import { Suspense } from "react";
import { PageHeader } from "@/components/admin/shared/PageHeader";
import { TableSkeleton } from "@/components/admin/shared/TableSkeleton";
import { PauseCodeList } from "@/components/admin/pause-codes/PauseCodeList";

export const metadata = { title: "Pause Codes · vici2 Admin" };

export default function PauseCodesPage(): React.ReactElement {
  return (
    <main>
      <PageHeader
        title="Pause Codes"
        description="Manage agent pause reason codes. Global codes apply to all campaigns."
      />
      <Suspense fallback={<TableSkeleton rows={5} cols={5} />}>
        <PauseCodeList />
      </Suspense>
    </main>
  );
}
