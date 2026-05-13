// AgentGrid unit tests — S01 supervisor dashboard.
//
// Tests: agent tile rendering, state badges, filter/sort behavior,
// monitor modal trigger on IN_CALL tile click.
//
// S01 PLAN §10.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentGrid } from "@/components/sup/AgentGrid.js";
import type { AgentSnapshot, CampaignMetrics } from "@/lib/stores/dashboard.js";

// Mock the MonitorModal (S02) — we test integration separately.
vi.mock("@/app/(sup)/monitor/MonitorModal.js", () => ({
  MonitorModal: ({ agent, onClose }: { agent: { displayName: string }; onClose: () => void }) => (
    <div data-testid="monitor-modal">
      <span>Monitor: {agent.displayName}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const CAMPAIGNS: CampaignMetrics[] = [
  {
    campaignId: 1,
    campaignName: "Sales Q2",
    dialLevel: 1.8,
    inFlight: 10,
    agentsReady: 2,
    agentsWaiting: 1,
    queueDepth: 0,
    leadsCallable: 1000,
    dropPct30d: 1.2,
    dropGated: false,
  },
];

function makeAgent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    uid: 1,
    displayName: "Alice",
    state: "READY",
    campaignId: 1,
    campaignName: "Sales Q2",
    callDurationSec: null,
    leadPhone: null,
    monitorCount: 0,
    teamId: null,
    ...overrides,
  };
}

describe("AgentGrid", () => {
  const noop = (): void => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all agent tiles", () => {
    const agents = [
      makeAgent({ uid: 1, displayName: "Alice", state: "READY" }),
      makeAgent({ uid: 2, displayName: "Bob", state: "IN_CALL", callDurationSec: 60 }),
    ];

    render(
      <AgentGrid
        agents={agents}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("shows state badges correctly", () => {
    const agents = [
      makeAgent({ uid: 1, displayName: "Alice", state: "READY" }),
      makeAgent({ uid: 2, displayName: "Bob", state: "IN_CALL", callDurationSec: 30 }),
      makeAgent({ uid: 3, displayName: "Carol", state: "WRAPUP" }),
    ];

    render(
      <AgentGrid
        agents={agents}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    // Use getAllByText because "Ready" also appears in the filter dropdown.
    expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In Call").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Wrap-up").length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty message when no agents match filter", () => {
    render(
      <AgentGrid
        agents={[]}
        campaigns={CAMPAIGNS}
        filter={{ state: "PAUSED" }}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    expect(
      screen.getByText(/no agents match the current filter/i),
    ).toBeInTheDocument();
  });

  it("opens MonitorModal when an IN_CALL tile is clicked", () => {
    const agent = makeAgent({ uid: 10, displayName: "David", state: "IN_CALL", callDurationSec: 45 });

    render(
      <AgentGrid
        agents={[agent]}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    // The tile is a button; click it.
    const tile = screen.getByRole("button", { name: /monitor david/i });
    fireEvent.click(tile);

    expect(screen.getByTestId("monitor-modal")).toBeInTheDocument();
    expect(screen.getByText("Monitor: David")).toBeInTheDocument();
  });

  it("does NOT open MonitorModal when a non-IN_CALL tile is clicked", () => {
    const agent = makeAgent({ uid: 11, displayName: "Eve", state: "READY" });

    render(
      <AgentGrid
        agents={[agent]}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    // READY tiles are not buttons — no role="button" should exist.
    expect(screen.queryByRole("button", { name: /monitor eve/i })).toBeNull();
    expect(screen.queryByTestId("monitor-modal")).toBeNull();
  });

  it("closes MonitorModal when onClose is called", () => {
    const agent = makeAgent({ uid: 12, displayName: "Frank", state: "IN_CALL", callDurationSec: 10 });

    render(
      <AgentGrid
        agents={[agent]}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    const tile = screen.getByRole("button", { name: /monitor frank/i });
    fireEvent.click(tile);
    expect(screen.getByTestId("monitor-modal")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByTestId("monitor-modal")).toBeNull();
  });

  it("shows monitor count badge when monitorCount > 0", () => {
    const agent = makeAgent({
      uid: 13,
      displayName: "Grace",
      state: "IN_CALL",
      callDurationSec: 20,
      monitorCount: 2,
    });

    render(
      <AgentGrid
        agents={[agent]}
        campaigns={CAMPAIGNS}
        filter={{}}
        sort="state"
        onFilterChange={noop}
        onSortChange={noop}
      />,
    );

    // The monitor count badge renders "2".
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

// Dashboard store selector tests — filter + sort logic.
describe("selectFilteredAgents", () => {
  it("sorts IN_CALL agents before READY before WRAPUP before PAUSED", async () => {
    const { selectFilteredAgents, useDashboardStore } = await import(
      "@/lib/stores/dashboard.js"
    );

    useDashboardStore.setState({
      agents: [
        makeAgent({ uid: 1, displayName: "A", state: "PAUSED" }),
        makeAgent({ uid: 2, displayName: "B", state: "READY" }),
        makeAgent({ uid: 3, displayName: "C", state: "IN_CALL", callDurationSec: 10 }),
        makeAgent({ uid: 4, displayName: "D", state: "WRAPUP" }),
      ],
    });

    const result = selectFilteredAgents(useDashboardStore.getState());
    expect(result.map((a) => a.state)).toEqual([
      "IN_CALL",
      "WRAPUP",
      "READY",
      "PAUSED",
    ]);
  });

  it("filters by state correctly", async () => {
    const { selectFilteredAgents, useDashboardStore } = await import(
      "@/lib/stores/dashboard.js"
    );

    useDashboardStore.setState({
      agents: [
        makeAgent({ uid: 1, displayName: "A", state: "READY" }),
        makeAgent({ uid: 2, displayName: "B", state: "IN_CALL", callDurationSec: 5 }),
      ],
      filter: { state: "READY" },
    });

    const result = selectFilteredAgents(useDashboardStore.getState());
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("A");
  });

  it("sorts by name alphabetically", async () => {
    const { selectFilteredAgents, useDashboardStore } = await import(
      "@/lib/stores/dashboard.js"
    );

    useDashboardStore.setState({
      agents: [
        makeAgent({ uid: 1, displayName: "Zara", state: "READY" }),
        makeAgent({ uid: 2, displayName: "Alice", state: "READY" }),
        makeAgent({ uid: 3, displayName: "Mike", state: "READY" }),
      ],
      filter: {},
      sort: "name",
    });

    const result = selectFilteredAgents(useDashboardStore.getState());
    expect(result.map((a) => a.displayName)).toEqual(["Alice", "Mike", "Zara"]);
  });

  it("sorts by duration descending (longest first)", async () => {
    const { selectFilteredAgents, useDashboardStore } = await import(
      "@/lib/stores/dashboard.js"
    );

    useDashboardStore.setState({
      agents: [
        makeAgent({ uid: 1, displayName: "A", state: "IN_CALL", callDurationSec: 30 }),
        makeAgent({ uid: 2, displayName: "B", state: "IN_CALL", callDurationSec: 120 }),
        makeAgent({ uid: 3, displayName: "C", state: "IN_CALL", callDurationSec: 10 }),
      ],
      filter: {},
      sort: "duration",
    });

    const result = selectFilteredAgents(useDashboardStore.getState());
    expect(result.map((a) => a.callDurationSec)).toEqual([120, 30, 10]);
  });
});
