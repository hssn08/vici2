// M01 — Admin users list page.
//
// Renders a server-shell + client UserTable component.
// URL: /admin/users

import { Suspense } from "react";
import { UserTable } from "@/components/admin/UserTable";

export const metadata = { title: "Users · vici2 Admin" };

export default function UsersPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Users</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage user accounts and role assignments.
          </p>
        </div>
        <a
          href="/admin/users/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          Add user
        </a>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading users" className="space-y-2">
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
        <UserTable />
      </Suspense>
    </main>
  );
}
