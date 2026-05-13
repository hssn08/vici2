// R03 — Recordings list page (admin route).
//
// Admin-role gate; re-uses the same RecordingsTable component as the
// supervisor route. Admin scope = tenant-wide.
//
// R03 PLAN §3.1.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { RecordingsTable } from "@/components/recordings/RecordingsTable";

export const metadata = { title: "Recordings — Admin — vici2" };

const ADMIN_ROLES = new Set(["super_admin", "admin"]);

export default async function AdminRecordingsPage(): Promise<React.ReactElement> {
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

  if (!ADMIN_ROLES.has(role)) redirect("/unauthorized");

  return (
    <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)]">
      <div className="mx-auto max-w-screen-xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Recordings</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Tenant-wide recording management. All access is logged to the audit trail (C03).
          </p>
        </div>

        <RecordingsTable basePath="/admin/recordings" />
      </div>
    </main>
  );
}
