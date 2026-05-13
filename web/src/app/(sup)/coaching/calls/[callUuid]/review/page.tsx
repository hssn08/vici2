// S05 — Review-call page (supervisor).
// RSC shell — fetches call metadata, templates, existing scorecard/annotations.
// S05 PLAN §3.2

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { ReviewShell } from "./ReviewShell";

export const metadata = { title: "Review Call — vici2" };

const ROLE_RANK: Record<string, number> = {
  super_admin: 40, admin: 30, supervisor: 20, agent: 10, viewer: 5, integrator: 0,
};

const API_BASE = process.env.API_URL ?? "http://api:3001";

async function fetchWithSession(url: string, sessionCookie: string) {
  const res = await fetch(url, {
    headers: { cookie: `sx_user=${sessionCookie}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

interface ReviewPageProps {
  params: Promise<{ callUuid: string }>;
}

export default async function ReviewCallPage({ params }: ReviewPageProps): Promise<React.ReactElement> {
  const { callUuid } = await params;
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

  const [callData, annotations, scorecard, templates] = await Promise.all([
    fetchWithSession(`${API_BASE}/api/sup/coaching/calls/${callUuid}`, sxUser),
    fetchWithSession(`${API_BASE}/api/sup/coaching/calls/${callUuid}/annotations`, sxUser),
    fetchWithSession(`${API_BASE}/api/sup/coaching/calls/${callUuid}/scorecard`, sxUser),
    fetchWithSession(`${API_BASE}/api/sup/coaching/templates`, sxUser),
  ]);

  if (!callData) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Call Not Found</h1>
          <p className="mt-2 text-sm text-gray-500">The requested call UUID was not found.</p>
          <a href="/sup/recordings" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
            Back to Recordings
          </a>
        </div>
      </main>
    );
  }

  return (
    <ReviewShell
      callUuid={callUuid}
      call={callData}
      annotations={annotations?.annotations ?? []}
      scorecard={scorecard?.scorecard ?? null}
      templates={templates?.templates ?? []}
    />
  );
}
