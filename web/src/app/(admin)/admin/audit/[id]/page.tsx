// M04 — Audit log row detail page.
//
// URL: /admin/audit/[id]

import { Suspense } from "react";
import { AuditLogDetail } from "@/components/admin/audit/AuditLogDetail";

export const metadata = { title: "Audit Row · vici2 Admin" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AuditLogDetailPage({ params }: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  return (
    <main>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading audit row" className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
                aria-hidden
              />
            ))}
          </div>
        }
      >
        <AuditLogDetail id={id} />
      </Suspense>
    </main>
  );
}
