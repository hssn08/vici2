// R03 — Recording detail page (supervisor route).
//
// Server component. Fetches detail from internal API.
// Redirects on auth failure. Falls back to a skeleton on fetch error.
//
// R03 PLAN §3.3.

import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { RecordingDetail } from "@/components/recordings/RecordingDetail";
import type { RecordingDetail as RecordingDetailType } from "@/components/recordings/types";

export const metadata = { title: "Recording detail — vici2" };

const ROLE_RANK: Record<string, number> = {
  super_admin: 40,
  admin: 30,
  supervisor: 20,
  agent: 10,
  viewer: 5,
  integrator: 0,
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RecordingDetailPage({ params }: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
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

  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK.supervisor && role !== "viewer") {
    redirect("/unauthorized");
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

  let recording: RecordingDetailType | null = null;
  try {
    // Forward auth cookie to the internal API for server-side fetch
    const res = await fetch(`${apiUrl}/api/recordings/${id}/detail`, {
      cache: "no-store",
      headers: {
        Cookie: `sx_user=${sxUser}`,
      },
    });
    if (res.status === 404) notFound();
    if (res.ok) {
      recording = (await res.json()) as RecordingDetailType;
    }
  } catch {
    // Network error — fall through to loading state
  }

  if (!recording) {
    return (
      <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)]">
        <div className="mx-auto max-w-screen-lg px-4 py-6 sm:px-6 lg:px-8">
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            Could not load recording. Please go back and try again.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)]">
      <div className="mx-auto max-w-screen-lg px-4 py-6 sm:px-6 lg:px-8">
        <RecordingDetail recording={recording} backPath="/sup/recordings" />
      </div>
    </main>
  );
}
