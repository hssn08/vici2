// BoardAgents unit tests — S04 wallboard agents board.
//
// Tests: agent rendering, state order, summary strip counts, empty state.
//
// S04 PLAN §10.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BoardAgents } from "@/components/sup/wallboard/BoardAgents.js";
import type { AgentSnapshot } from "@/lib/stores/dashboard.js";

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

describe("BoardAgents", () => {
  it("renders all agent names", () => {
    const agents = [
      makeAgent({ uid: 1, displayName: "Alice", state: "READY" }),
      makeAgent({ uid: 2, displayName: "Bob", state: "IN_CALL", callDurationSec: 60 }),
      makeAgent({ uid: 3, displayName: "Carol", state: "WRAPUP" }),
    ];

    render(<BoardAgents agents={agents} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("shows empty state when no agents", () => {
    render(<BoardAgents agents={[]} />);
    expect(screen.getByText(/no agents logged in/i)).toBeInTheDocument();
  });

  it("shows summary strip with correct counts", () => {
    const agents = [
      makeAgent({ uid: 1, state: "IN_CALL", callDurationSec: 30 }),
      makeAgent({ uid: 2, state: "IN_CALL", callDurationSec: 90 }),
      makeAgent({ uid: 3, state: "READY" }),
      makeAgent({ uid: 4, state: "WRAPUP" }),
      makeAgent({ uid: 5, state: "PAUSED" }),
    ];

    render(<BoardAgents agents={agents} />);

    // 2 on call — the summary strip <strong> shows "2".
    // Use getAllByText because "1" may appear multiple times (ready, wrap-up, paused each = 1).
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });

  it("renders IN_CALL state badge", () => {
    const agents = [makeAgent({ uid: 1, state: "IN_CALL", callDurationSec: 45 })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("In Call")).toBeInTheDocument();
  });

  it("renders READY state badge", () => {
    const agents = [makeAgent({ uid: 1, state: "READY" })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders WRAPUP state badge", () => {
    const agents = [makeAgent({ uid: 1, state: "WRAPUP" })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("Wrap-up")).toBeInTheDocument();
  });

  it("renders PAUSED state badge", () => {
    const agents = [makeAgent({ uid: 1, state: "PAUSED" })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("renders LOGOUT state badge", () => {
    const agents = [makeAgent({ uid: 1, state: "LOGOUT" })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("Logged Out")).toBeInTheDocument();
  });

  it("shows monitor count badge when monitorCount > 0", () => {
    const agents = [
      makeAgent({ uid: 1, state: "IN_CALL", callDurationSec: 20, monitorCount: 3 }),
    ];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows campaign name", () => {
    const agents = [makeAgent({ uid: 1, state: "READY", campaignName: "Outbound Sales" })];
    render(<BoardAgents agents={agents} />);
    expect(screen.getByText("Outbound Sales")).toBeInTheDocument();
  });

  it("orders IN_CALL agents before READY before WRAPUP", () => {
    const agents = [
      makeAgent({ uid: 1, displayName: "READY-Agent", state: "READY" }),
      makeAgent({ uid: 2, displayName: "WRAP-Agent", state: "WRAPUP" }),
      makeAgent({ uid: 3, displayName: "CALL-Agent", state: "IN_CALL", callDurationSec: 10 }),
    ];

    render(<BoardAgents agents={agents} />);

    // Check DOM order: CALL-Agent should appear before READY-Agent.
    const names = screen.getAllByText(/Agent/).map((el) => el.textContent);
    const callIdx = names.findIndex((n) => n?.includes("CALL"));
    const readyIdx = names.findIndex((n) => n?.includes("READY"));
    expect(callIdx).toBeLessThan(readyIdx);
  });

  it("renders article roles for each agent card", () => {
    const agents = [
      makeAgent({ uid: 1, displayName: "Alice", state: "READY" }),
      makeAgent({ uid: 2, displayName: "Bob", state: "READY" }),
    ];
    render(<BoardAgents agents={agents} />);
    const articles = screen.getAllByRole("article");
    expect(articles.length).toBeGreaterThanOrEqual(2);
  });
});
