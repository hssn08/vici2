// WallboardClient unit tests — S04 TV wallboard.
//
// Tests: board rotation, board rendering, WS disconnection banner,
// board navigation via RotationDots.
//
// S04 PLAN §10.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WallboardClient } from "@/components/sup/wallboard/WallboardClient.js";
import type { AgentSnapshot, CampaignMetrics, SystemHealth } from "@/lib/stores/dashboard.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the WS store so tests don't require a real WebSocket.
vi.mock("@/lib/stores/ws.js", () => ({
  useWsStore: (selector: (s: { connection: string }) => unknown) =>
    selector({ connection: "open" }),
}));

// Mock Wake Lock so tests don't throw in jsdom.
vi.mock("@/lib/hooks/useWakeLock.js", () => ({
  useWakeLock: () => ({ supported: false, active: false, release: async () => {} }),
}));

// Mock Fullscreen hook.
vi.mock("@/lib/hooks/useFullscreen.js", () => ({
  useFullscreen: () => ({
    ref: { current: null },
    fullscreen: false,
    supported: false,
    toggle: async () => {},
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENTS: AgentSnapshot[] = [
  {
    uid: 1,
    displayName: "Alice",
    state: "IN_CALL",
    campaignId: 1,
    campaignName: "Sales Q2",
    callDurationSec: 120,
    leadPhone: "4567",
    monitorCount: 0,
    teamId: null,
  },
  {
    uid: 2,
    displayName: "Bob",
    state: "READY",
    campaignId: 1,
    campaignName: "Sales Q2",
    callDurationSec: null,
    leadPhone: null,
    monitorCount: 0,
    teamId: null,
  },
];

const CAMPAIGNS: CampaignMetrics[] = [
  {
    campaignId: 1,
    campaignName: "Sales Q2",
    dialLevel: 1.8,
    inFlight: 10,
    agentsReady: 2,
    agentsWaiting: 1,
    queueDepth: 3,
    leadsCallable: 1000,
    dropPct30d: 1.2,
    dropGated: false,
  },
];

const HEALTH: SystemHealth = {
  freeswitchUp: true,
  mysqlUp: true,
  valkeyUp: true,
  dialerPodsUp: 2,
  dialerPodsTotal: 2,
  scrapeStalenessMs: 500,
  scrapeAt: new Date().toISOString(),
};

function renderWallboard(props: Partial<React.ComponentProps<typeof WallboardClient>> = {}) {
  return render(
    <WallboardClient
      initialAgents={AGENTS}
      initialCampaigns={CAMPAIGNS}
      initialHealth={HEALTH}
      rotateSeconds={30}
      theme="dark"
      {...props}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WallboardClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders without crashing", () => {
    renderWallboard();
    expect(screen.getByTestId("wallboard-root")).toBeInTheDocument();
  });

  it("renders the default first board (agents)", () => {
    renderWallboard();
    // The header should show "Agents on Calls" board title.
    const matches = screen.getAllByText(/agents on calls/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders only the boards specified by boardsParam", () => {
    renderWallboard({ boardsParam: "campaigns" });
    expect(screen.getByText(/campaign performance/i)).toBeInTheDocument();
  });

  it("renders rotation dots when multiple boards are active", () => {
    renderWallboard({ boardsParam: "agents,campaigns" });
    expect(screen.getByRole("navigation", { name: /wallboard board navigation/i })).toBeInTheDocument();
  });

  it("does NOT render rotation dots when only one board is active", () => {
    renderWallboard({ boardsParam: "agents" });
    expect(screen.queryByRole("navigation", { name: /wallboard board navigation/i })).toBeNull();
  });

  it("clicking a rotation dot navigates to that board", () => {
    renderWallboard({ boardsParam: "agents,campaigns" });

    // Initial board is "agents" — header shows "Agents on Calls".
    expect(screen.getAllByText(/agents on calls/i).length).toBeGreaterThanOrEqual(1);

    // Click the "Campaign Performance" dot.
    const campaignDot = screen.getByRole("button", { name: /go to campaign performance/i });
    fireEvent.click(campaignDot);

    // After navigation the campaign board renders; the dot label is also visible.
    expect(screen.getAllByText(/campaign performance/i).length).toBeGreaterThanOrEqual(1);
  });

  it("does not show WS disconnection banner when WS is open", () => {
    // WS is mocked as "open" in this test file; banner should be absent.
    renderWallboard();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the agents board with agent names", () => {
    renderWallboard({ boardsParam: "agents" });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("renders the campaigns board with campaign names", () => {
    renderWallboard({ boardsParam: "campaigns" });
    expect(screen.getByText("Sales Q2")).toBeInTheDocument();
  });

  it("renders the queue board with waiting count", () => {
    renderWallboard({ boardsParam: "queue" });
    // Should display queue depth (3 from CAMPAIGNS fixture).
    // Use getAllByText because "Waiting" appears in both summary and column header.
    expect(screen.getAllByText(/waiting/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the performers board", () => {
    renderWallboard({ boardsParam: "performers" });
    // Alice is IN_CALL so she should appear.
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("applies dark theme background", () => {
    renderWallboard({ theme: "dark" });
    const root = screen.getByTestId("wallboard-root");
    expect(root.style.background).toBe("rgb(10, 13, 20)");
  });

  it("applies light theme background", () => {
    renderWallboard({ theme: "light" });
    const root = screen.getByTestId("wallboard-root");
    expect(root.style.background).toBe("rgb(248, 250, 252)");
  });
});

// ── useWallboardRotation tests ────────────────────────────────────────────────

describe("useWallboardRotation", () => {
  it("returns the first board initially", async () => {
    const { useWallboardRotation } = await import("@/lib/hooks/useWallboardRotation.js");
    const { renderHook } = await import("@testing-library/react");

    const { result } = renderHook(() =>
      useWallboardRotation(["agents", "campaigns", "queue"], 1000),
    );

    expect(result.current.currentBoard).toBe("agents");
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.total).toBe(3);
  });

  it("goTo navigates to the specified index", async () => {
    const { useWallboardRotation } = await import("@/lib/hooks/useWallboardRotation.js");
    const { renderHook, act: hookAct } = await import("@testing-library/react");

    const { result } = renderHook(() =>
      useWallboardRotation(["agents", "campaigns", "queue"], 30_000),
    );

    await hookAct(async () => {
      result.current.goTo(2);
    });

    expect(result.current.currentIndex).toBe(2);
    expect(result.current.currentBoard).toBe("queue");
  });

  it("handles empty boards array gracefully", async () => {
    const { useWallboardRotation } = await import("@/lib/hooks/useWallboardRotation.js");
    const { renderHook } = await import("@testing-library/react");

    const { result } = renderHook(() => useWallboardRotation([], 1000));
    expect(result.current.currentBoard).toBe("");
    expect(result.current.total).toBe(0);
  });

  it("handles single board (no rotation)", async () => {
    const { useWallboardRotation } = await import("@/lib/hooks/useWallboardRotation.js");
    const { renderHook } = await import("@testing-library/react");

    const { result } = renderHook(() => useWallboardRotation(["agents"], 1000));
    expect(result.current.currentBoard).toBe("agents");
    expect(result.current.total).toBe(1);
  });
});

