// R03 — Recordings list page (supervisor route).
//
// Server component. Redirects to /login if unauthenticated.
// Requires supervisor+ role. The actual data fetching is client-side
// (RecordingsTable) so cursor pagination and filter changes work without
// full page reloads.
//
// R03 PLAN §3.1.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { RecordingsTable } from "@/components/recordings/RecordingsTable";

export const metadata = { title: "Recordings — vici2" };

const ROLE_RANK: Record<string, number> = {
  super_admin: 40,
  admin: 30,
  supervisor: 20,
  agent: 10,
  viewer: 5,
  integrator: 0,
};

export default async function RecordingsPage(): Promise<React.ReactElement> {
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

  // Require supervisor or higher (includes viewers who have recording:list)
  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK.supervisor && role !== "viewer") {
    redirect("/unauthorized");
  }

  return (
    <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)]">
      <div className="mx-auto max-w-screen-xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Recordings</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Browse, listen, and download call recordings. All access is logged to the audit trail.
          </p>
        </div>

        <RecordingsTable basePath="/sup/recordings" />
      </div>
    </main>
  );
}
