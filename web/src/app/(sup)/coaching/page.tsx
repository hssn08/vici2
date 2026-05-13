// S05 — Coaching hub page (supervisor).
// Coaching hub: recent reviews, team summary.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";

export const metadata = { title: "Coaching — vici2" };

const ROLE_RANK: Record<string, number> = {
  super_admin: 40, admin: 30, supervisor: 20, agent: 10, viewer: 5, integrator: 0,
};

export default async function CoachingHubPage(): Promise<React.ReactElement> {
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

  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK.supervisor) {
    redirect("/unauthorized");
  }

  return (
    <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)]">
      <div className="mx-auto max-w-screen-xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Coaching</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review calls, score agent performance, and send coaching feedback.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Quick links */}
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Quick Actions</h2>
            <nav className="flex flex-col gap-2" aria-label="Coaching quick actions">
              <a
                href="/sup/recordings"
                className="rounded-md px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
              >
                Open a Recording to Review
              </a>
              <a
                href="/admin/coaching/templates"
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                Manage Scorecard Templates
              </a>
            </nav>
          </div>

          {/* Info cards */}
          <div className="lg:col-span-2 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Team Performance Overview</h2>
            <p className="text-sm text-gray-500">
              Use the recordings browser to open calls for review, or navigate to an agent profile to view their scorecard history.
            </p>
            <p className="mt-3 text-xs text-gray-400">
              Tip: From the Recordings page, click the &quot;Review&quot; action on any completed call to open the coaching review panel.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
