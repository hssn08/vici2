"use client";

// M01 — Admin user table component.
//
// Fetches users from the API (offset pagination), renders a table with
// sort/filter controls, and links to edit/delete actions.
//
// A11y: data is in a proper <table> with role="grid"; interactive cells
// have explicit aria-labels; sort buttons expose aria-sort.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types (mirrors api/src/routes/admin/users/schema.ts)
// ---------------------------------------------------------------------------

interface UserResponse {
  id: string;
  username: string;
  email: string | null;
  fullName: string | null;
  role: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserListResponse {
  data: UserResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

type SortField = "username" | "email" | "role" | "active" | "createdAt" | "lastLoginAt";
type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// Role badge colour
// ---------------------------------------------------------------------------

const ROLE_BADGE_CLASS: Record<string, string> = {
  super_admin: "bg-[var(--color-brand-100)] text-[var(--color-brand-700)]",
  admin: "bg-blue-100 text-blue-700",
  supervisor: "bg-purple-100 text-purple-700",
  agent: "bg-green-100 text-green-700",
  integrator: "bg-orange-100 text-orange-700",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UserTable(): React.ReactElement {
  const [users, setUsers] = React.useState<UserResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(50);
  const [sort, setSort] = React.useState<SortField>("username");
  const [dir, setDir] = React.useState<SortDir>("asc");
  const [search, setSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch
  const fetchUsers = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sort,
        dir,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      const result = await api.get<UserListResponse>(`/api/admin/users?${params}`);
      setUsers(result.data);
      setTotalCount(result.totalCount);
      setTotalPages(result.totalPages);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to load users";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sort, dir, debouncedSearch]);

  React.useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleSort = (field: SortField): void => {
    if (field === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir("asc");
    }
    setPage(1);
  };

  const handleDelete = async (userId: string, username: string): Promise<void> => {
    if (!window.confirm(`Delete user "${username}"? This action cannot be undone.`)) return;
    setDeletingId(userId);
    try {
      await api.delete(`/api/admin/users/${userId}`);
      await fetchUsers();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Delete failed";
      setError(msg);
    } finally {
      setDeletingId(null);
    }
  };

  const SortBtn = ({
    field,
    children,
  }: {
    field: SortField;
    children: React.ReactNode;
  }): React.ReactElement => {
    const active = sort === field;
    return (
      <button
        type="button"
        onClick={() => handleSort(field)}
        className="flex items-center gap-1 font-medium hover:text-[var(--color-brand-600)]"
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {children}
        {active && <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>}
      </button>
    );
  };

  return (
    <section aria-label="Users list">
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <label htmlFor="user-search" className="sr-only">
          Search users
        </label>
        <Input
          id="user-search"
          type="search"
          placeholder="Search username, email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
          aria-label="Search users by username or email"
        />
        <span
          aria-live="polite"
          aria-atomic
          className="ml-auto text-sm text-[var(--color-fg-muted)]"
        >
          {loading ? "Loading…" : `${totalCount} user${totalCount !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table
          role="grid"
          aria-label="Users"
          aria-busy={loading}
          className="min-w-full text-sm"
        >
          <thead className="bg-[var(--color-surface-muted)] text-left text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            <tr>
              <th scope="col" className="px-4 py-3">
                <SortBtn field="username">Username</SortBtn>
              </th>
              <th scope="col" className="px-4 py-3">
                <SortBtn field="email">Email</SortBtn>
              </th>
              <th scope="col" className="px-4 py-3">
                <SortBtn field="role">Role</SortBtn>
              </th>
              <th scope="col" className="px-4 py-3">
                <SortBtn field="active">Status</SortBtn>
              </th>
              <th scope="col" className="px-4 py-3">
                <SortBtn field="lastLoginAt">Last login</SortBtn>
              </th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-surface-border)]">
            {users.map((user) => (
              <tr
                key={user.id}
                className="bg-[var(--color-surface-elevated)] hover:bg-[var(--color-surface-muted)] transition-colors"
              >
                <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                  <a
                    href={`/admin/users/${user.id}`}
                    className="hover:underline focus:rounded focus:outline-2 focus:outline-[var(--color-brand-600)]"
                  >
                    {user.username}
                  </a>
                  {user.fullName ? (
                    <p className="text-xs text-[var(--color-fg-muted)]">{user.fullName}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                  {user.email ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                      ROLE_BADGE_CLASS[user.role] ?? "bg-gray-100 text-gray-700",
                    )}
                  >
                    {user.role.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={user.active ? "success" : "neutral"}>
                    {user.active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                  {user.lastLoginAt
                    ? new Date(user.lastLoginAt).toLocaleString()
                    : "Never"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <a
                      href={`/admin/users/${user.id}`}
                      className="text-sm text-[var(--color-brand-600)] hover:underline focus:rounded focus:outline-2 focus:outline-[var(--color-brand-600)]"
                      aria-label={`Edit user ${user.username}`}
                    >
                      Edit
                    </a>
                    <Button
                      variant="destructive"
                      size="sm"
                      loading={deletingId === user.id}
                      onClick={() => void handleDelete(user.id, user.username)}
                      aria-label={`Delete user ${user.username}`}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}

            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="mt-4 flex items-center justify-between text-sm"
        >
          <p className="text-[var(--color-fg-muted)]">
            Page {page} of {totalPages} ({totalCount} total)
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous page"
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
