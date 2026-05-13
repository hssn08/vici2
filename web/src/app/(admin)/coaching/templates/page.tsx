// S05 — Admin template management page.
// S05 PLAN §10.2

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";

export const metadata = { title: "Scorecard Templates — vici2" };

const ROLE_RANK: Record<string, number> = {
  super_admin: 40, admin: 30, supervisor: 20, agent: 10, viewer: 5, integrator: 0,
};

const API_BASE = process.env.API_URL ?? "http://api:3001";

interface TemplateRow {
  id: string;
  name: string;
  description?: string | null;
  version: number;
  active: boolean;
  createdAt: string;
  creator?: { fullName: string | null; username: string } | null;
}

export default async function TemplateManagementPage(): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const sxUser = cookieStore.get("sx_user")?.value;
  if (!sxUser) redirect("/login");

  let role = "agent";
  try {
    const claims = decodeJwt(sxUser);
    role = typeof claims.role === "string" ? claims.role : "agent";
  } catch {
    redirect("/login");
  }

  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK.admin) {
    redirect("/unauthorized");
  }

  const res = await fetch(`${API_BASE}/api/admin/coaching/templates`, {
    headers: { cookie: `sx_user=${sxUser}` },
    cache: "no-store",
  });

  const templates: TemplateRow[] = res.ok
    ? ((await res.json()) as { templates: TemplateRow[] }).templates
    : [];

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-screen-lg px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              Scorecard Templates
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Create and manage evaluation templates for quality reviews.
            </p>
          </div>
          <a
            href="/admin/coaching/templates/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            New Template
          </a>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm" aria-label="Scorecard templates">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Version
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Created By
                </th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {templates.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                    No templates yet. Create one to get started.
                  </td>
                </tr>
              )}
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900">{t.name}</p>
                      {t.description && (
                        <p className="text-xs text-gray-500 line-clamp-1">{t.description}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">v{t.version}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        t.active
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {t.active ? "Active" : "Archived"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {t.creator?.fullName ?? t.creator?.username ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <a
                        href={`/admin/coaching/templates/${t.id}`}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800"
                      >
                        View
                      </a>
                      {t.active && (
                        <a
                          href={`/admin/coaching/templates/${t.id}/edit`}
                          className="text-xs font-medium text-gray-600 hover:text-gray-800"
                        >
                          Edit
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
