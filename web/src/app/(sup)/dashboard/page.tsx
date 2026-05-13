// S01 — Supervisor Dashboard page (server component).
//
// Performs a server-side data fetch for initial props (avoids CLS / loading
// spinner on first paint). RBAC check via cookie: redirects to /unauthorized
// if the user lacks supervisor or higher role.
//
// S01 PLAN §1, §8.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { DashboardClient } from "@/components/sup/DashboardClient.js";
import type { AgentSnapshot, CampaignMetrics, SystemHealth } from "@/lib/stores/dashboard.js";

export const metadata = { title: "Supervisor Dashboard — vici2" };

// Role hierarchy: super_admin(40) > admin(30) > supervisor(20) > agent(10).
const ROLE_RANK: Record<string, number> = {
  super_admin: 40,
  admin: 30,
  supervisor: 20,
  agent: 10,
  integrator: 0,
};

async function fetchInitialData(apiUrl: string): Promise<{
  agents: AgentSnapshot[];
  campaigns: CampaignMetrics[];
  health: SystemHealth | null;
}> {
  // In the App Router, server components can hit internal API routes directly.
  // We use the absolute URL so this also works in production behind a proxy.
  try {
    const [agentsRes, campaignsRes, healthRes] = await Promise.allSettled([
      fetch(`${apiUrl}/api/sup/agents`, { cache: "no-store" }),
      fetch(`${apiUrl}/api/sup/campaigns/metrics`, { cache: "no-store" }),
      fetch(`${apiUrl}/api/sup/health`, { cache: "no-store" }),
    ]);

    const agents =
      agentsRes.status === "fulfilled" && agentsRes.value.ok
        ? ((await agentsRes.value.json()) as { agents: AgentSnapshot[] }).agents
        : [];

    const campaigns =
      campaignsRes.status === "fulfilled" && campaignsRes.value.ok
        ? ((await campaignsRes.value.json()) as { campaigns: CampaignMetrics[] }).campaigns
        : [];

    const health =
      healthRes.status === "fulfilled" && healthRes.value.ok
        ? ((await healthRes.value.json()) as SystemHealth)
        : null;

    return { agents, campaigns, health };
  } catch {
    return { agents: [], campaigns: [], health: null };
  }
}

export default async function DashboardPage(): Promise<React.ReactElement> {
  // RBAC: check the sx_user cookie for role.
  // Phase 1: decode without signature verification (middleware has already
  // validated). F05's jose-verified middleware runs at the edge; by the time
  // we reach here the cookie is trustworthy.
  const cookieStore = await cookies();
  const sxUser = cookieStore.get("sx_user")?.value;

  if (!sxUser) {
    redirect("/login");
  }

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

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

  const { agents, campaigns, health } = await fetchInitialData(apiUrl);

  return (
    <main className="min-h-screen bg-[var(--color-surface-muted,#f8fafc)] dark:bg-gray-950">
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Page header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Supervisor Dashboard</h1>
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
              Live agent grid, campaign KPIs, and system health.
            </p>
          </div>
        </div>

        {/* Client island — handles real-time updates */}
        <DashboardClient
          initialAgents={agents}
          initialCampaigns={campaigns}
          initialHealth={health}
        />
      </div>
    </main>
  );
}
