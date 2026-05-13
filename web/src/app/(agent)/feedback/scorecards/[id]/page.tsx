// S05 — Agent scorecard detail page (read-only).
// S05 PLAN §6.2

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import type { CallScorecard } from "@/components/coaching/types";
import { ScorecardForm } from "@/components/coaching/ScorecardForm";
import { AnnotationPanel } from "@/components/coaching/AnnotationPanel";

export const metadata = { title: "Scorecard — vici2" };

const API_BASE = process.env.API_URL ?? "http://api:3001";

interface ScorecardDetailProps {
  params: Promise<{ id: string }>;
}

export default async function AgentScorecardDetailPage({
  params,
}: ScorecardDetailProps): Promise<React.ReactElement> {
  const { id } = await params;
  const cookieStore = await cookies();
  const sxUser = cookieStore.get("sx_user")?.value;
  if (!sxUser) redirect("/login");

  const res = await fetch(`${API_BASE}/api/agent/scorecards/${id}`, {
    headers: { cookie: `sx_user=${sxUser}` },
    cache: "no-store",
  });

  if (!res.ok) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Scorecard Not Found</h1>
          <a href="/feedback" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
            Back to Feedback
          </a>
        </div>
      </main>
    );
  }

  const json = await res.json() as { scorecard: CallScorecard };
  const scorecard = json.scorecard;
  const template = scorecard.template;
  const annotations = scorecard.annotations ?? [];

  if (!template) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Template not found for this scorecard.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-center gap-4">
          <a href="/feedback" className="text-sm text-blue-600 hover:underline">
            ← Back to Feedback
          </a>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              {template.name}
            </h1>
            {scorecard.finalized_at && (
              <p className="text-xs text-gray-500 mt-0.5">
                Evaluated on {new Date(scorecard.finalized_at).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          {/* Scorecard */}
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <ScorecardForm
              template={template}
              scorecard={scorecard}
              readOnly={true}
            />
          </div>

          {/* Annotations */}
          {annotations.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">
                Annotations ({annotations.length})
              </h2>
              <AnnotationPanel
                annotations={annotations}
                readOnly={true}
                isLocked={true}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
