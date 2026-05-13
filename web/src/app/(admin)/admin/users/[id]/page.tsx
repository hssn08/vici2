// M01 — Admin edit-user page.
// URL: /admin/users/[id]

import { UserEditClient } from "@/components/admin/UserEditClient";

export const metadata = { title: "Edit User · vici2 Admin" };

export default function EditUserPage({
  params,
}: {
  params: { id: string };
}): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <li>
              <a href="/admin/users" className="hover:underline">
                Users
              </a>
            </li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="text-[var(--color-fg)]">
              Edit user
            </li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">Edit user</h1>
      </div>

      <div className="max-w-lg">
        <UserEditClient userId={params.id} />
      </div>
    </main>
  );
}
