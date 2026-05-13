// S04 — Supervisor Wallboard page (server component).
//
// Large-format live dashboard for call-floor TV screens.
// No shell chrome — full-screen layout.
//
// RBAC: supervisor or admin; redirects to /unauthorized otherwise.
// Initial data fetched server-side to avoid CLS on first paint.
//
// S04 PLAN §1, §6.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { WallboardClient } from "@/components/sup/wallboard/WallboardClient.js";
import type { AgentSnapshot, CampaignMetrics, SystemHealth } from "@/lib/stores/dashboard.js";

export const metadata = { title: "Wallboard — vici2" };

// Suppress the standard viewport so our full-screen CSS can take over.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

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

export default async function WallboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  // RBAC: check the sx_user cookie.
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

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
  const { agents, campaigns, health } = await fetchInitialData(apiUrl);

  // Parse URL params (Next.js 14 async searchParams).
  const sp = await searchParams;
  const rotateSeconds = parseInt(
    typeof sp.rotate === "string" ? sp.rotate : "30",
    10,
  );
  const boardsParam = typeof sp.boards === "string" ? sp.boards : undefined;
  const theme = typeof sp.theme === "string" ? sp.theme : "dark";

  return (
    <WallboardClient
      initialAgents={agents}
      initialCampaigns={campaigns}
      initialHealth={health}
      rotateSeconds={isNaN(rotateSeconds) || rotateSeconds < 5 ? 30 : rotateSeconds}
      boardsParam={boardsParam}
      theme={theme as "dark" | "light"}
    />
  );
}
