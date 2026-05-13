# Module S01 — Supervisor Dashboard — PLAN

| Field | Value |
|---|---|
| Track | Supervisor |
| Phase | 3 |
| Status | PLAN |
| Author | S01-IMPLEMENT agent |
| Date | 2026-05-13 |
| Depends on | S02 (MonitorModal), F05 (RBAC), A01 (sup route group), E05 (drop gauges) |

---

## 0. TL;DR

S01 ships `/sup/dashboard` — the live supervisor wallboard. Three panels:

1. **Agent grid** — tile per active agent; state badge, call timer, lead info; click-to-monitor via S02's MonitorModal.
2. **Campaign metrics row** — per-campaign KPIs (drop%, dial_level, in_flight, agents_ready, queue_depth).
3. **System health strip** — service liveness (FS, MySQL, Valkey, dialer pods, scrape staleness).

Real-time updates via WebSocket events. RBAC gate: `supervisor` or `admin`.

---

## 1. Route

```
web/src/app/(sup)/dashboard/page.tsx   ← server shell + RBAC check
```

Replaces the stub at `(sup)/sup/page.tsx` in terms of role; the `/sup` route stays as a redirect to `/sup/dashboard`.

---

## 2. API endpoints (new, in api/src/routes/supervisor/)

| Endpoint | Purpose |
|---|---|
| `GET /api/sup/agents` | Snapshot of all active agents for this tenant |
| `GET /api/sup/campaigns/metrics` | Per-campaign KPI snapshot |
| `GET /api/sup/health` | Service health (FS, MySQL, Valkey, dialer) |

All three are stub implementations returning mock data in Phase 1 (real data wiring is blocked on T03/E05 backends shipping). The API shape is frozen here so the UI can be wired.

---

## 3. Data shapes

### 3.1 Agent

```ts
interface AgentSnapshot {
  uid: number;
  displayName: string;
  state: "READY" | "IN_CALL" | "WRAPUP" | "PAUSED" | "LOGOUT";
  campaignId: number | null;
  campaignName: string | null;
  callDurationSec: number | null;   // null if not IN_CALL
  leadPhone: string | null;         // last 4 digits only
  monitorCount: number;             // active supervisors on this agent
  teamId: number | null;
}
```

### 3.2 Campaign metrics

```ts
interface CampaignMetrics {
  campaignId: number;
  campaignName: string;
  dialLevel: number;
  inFlight: number;
  agentsReady: number;
  agentsWaiting: number;
  queueDepth: number;
  leadsCallable: number;
  dropPct30d: number;
  dropGated: boolean;
}
```

### 3.3 System health

```ts
interface SystemHealth {
  freeswitchUp: boolean;
  mysqlUp: boolean;
  valkeyUp: boolean;
  dialerPodsUp: number;
  dialerPodsTotal: number;
  scrapeStalenessMs: number;
  scrapeAt: string;  // ISO-8601
}
```

---

## 4. WebSocket subscriptions

The dashboard subscribes to:

- `events:vici2.agent.state` — agent state change events; update the agent tile in place.
- `events:vici2.campaign.metrics` — campaign KPI updates; refresh campaign row.

Events arrive via the existing `lib/ws.ts` `createReconnectingWs` client from A01. Events fire a Zustand store update (`useDashboardStore`).

Polling fallback: if WS is disconnected, auto-poll `/api/sup/agents` and `/api/sup/campaigns/metrics` every 5 seconds via a `useEffect`.

---

## 5. Component tree

```
(sup)/dashboard/page.tsx  [server]
  └── <DashboardClient />  [client, 'use client']
        ├── <SystemHealthStrip />
        ├── <CampaignMetricsRow campaigns={...} />
        │     └── <CampaignCard key={id} metrics={...} />
        │           └── <DropGauge pct={...} gated={...} />
        └── <AgentGrid agents={...} filters={...} />
              ├── <AgentFilterBar />
              └── <AgentTile key={uid} agent={...} onClick={() => openMonitor(agent)} />
                    → MonitorModal (S02, opens when IN_CALL tile clicked)
```

---

## 6. State management

`useDashboardStore` (Zustand, in `web/src/lib/stores/dashboard.ts`):

```ts
{
  agents: AgentSnapshot[];
  campaigns: CampaignMetrics[];
  health: SystemHealth | null;
  filter: { state?: AgentState; campaignId?: number };
  sort: "state" | "name" | "duration";
  setAgents, setCampaigns, setHealth,
  setFilter, setSort,
  patchAgent(uid, partial),
  patchCampaign(id, partial),
}
```

---

## 7. Files to create

```
spec/modules/S01/PLAN.md                          ← this file
web/src/app/(sup)/dashboard/page.tsx              ← server shell + metadata
web/src/lib/stores/dashboard.ts                   ← Zustand store
web/src/components/sup/AgentGrid.tsx              ← agent tile grid + filter bar
web/src/components/sup/AgentTile.tsx              ← single agent tile
web/src/components/sup/AgentFilterBar.tsx         ← filter/sort controls
web/src/components/sup/CampaignMetricsRow.tsx     ← campaign row
web/src/components/sup/CampaignCard.tsx           ← single campaign card
web/src/components/sup/DropGauge.tsx              ← drop% gauge
web/src/components/sup/SystemHealthStrip.tsx      ← FS/MySQL/Valkey health bar
web/src/components/sup/DashboardClient.tsx        ← top-level client island
api/src/routes/supervisor/dashboard.agents.ts     ← GET /api/sup/agents
api/src/routes/supervisor/dashboard.campaigns.ts  ← GET /api/sup/campaigns/metrics
api/src/routes/supervisor/dashboard.health.ts     ← GET /api/sup/health
web/src/test/unit/sup.AgentGrid.test.tsx          ← AgentGrid tests
web/src/test/unit/sup.CampaignCard.test.tsx       ← CampaignCard/DropGauge tests
```

---

## 8. RBAC

Server component (`page.tsx`) checks `role` from the session cookie (`sx_user`) and redirects to `/unauthorized` if the role is below `supervisor`. Client components receive agents/campaigns from the server as initial props; the client then subscribes to WS events.

---

## 9. Drop gauge colors

Mirrors E05 Safe Harbor thresholds:
- Green: < 1.5%
- Amber: ≥ 1.5% and < 3%
- Red: ≥ 3% (gated if `dropGated=true`)

---

## 10. Acceptance criteria

- All panels render with mock data via static props.
- AgentGrid filters by state and campaign; sorts by name and call duration.
- Clicking an IN_CALL tile opens MonitorModal (S02).
- Campaign row shows drop gauge with correct color thresholds.
- System health strip shows up/down status per service.
- WS event for agent state change updates tile without full reload.
- `pnpm test` passes (AgentGrid + CampaignCard unit tests).
- `pnpm typecheck` and `pnpm lint` clean.
