// M01 — Admin create-user page.
// URL: /admin/users/new

import { UserForm } from "@/components/admin/UserForm";

export const metadata = { title: "New User · vici2 Admin" };

export default function NewUserPage(): React.ReactElement {
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
              New user
            </li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">Create user</h1>
      </div>

      <div className="max-w-lg">
        <UserForm mode="create" />
      </div>
    </main>
  );
}
