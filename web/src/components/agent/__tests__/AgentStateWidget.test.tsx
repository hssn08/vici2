import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import { AgentStateWidget } from "../AgentStateWidget";
import { useAgentStore } from "@/lib/stores/agent";
import { Toaster } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Mock agent API — A09: getPauseCodes now returns PauseCodesConfig
// ---------------------------------------------------------------------------

vi.mock("@/lib/agent", () => ({
  getAgentState: vi.fn(),
  setAgentState: vi.fn().mockResolvedValue({
    status: "ready",
    pauseCode: null,
    pausedSince: null,
    currentCampaignId: null,
  }),
  getPauseCodes: vi.fn().mockResolvedValue({
    pauseCodesRequired: "OPTIONAL",
    codes: [
      { code: "LUNCH", name: "Lunch Break", billable: false },
      { code: "TRAIN", name: "Training", billable: true },
    ],
  }),
  useAgentState: vi.fn().mockReturnValue({
    status: "logged-out",
    pauseCode: null,
    pausedSince: null,
    currentCampaignId: null,
    pauseConfig: {
      pauseCodesRequired: "OPTIONAL",
      codes: [],
      loading: false,
      error: null,
    },
    transitioning: false,
    pause: vi.fn(),
    unpause: vi.fn(),
    refreshPauseConfig: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useAgentStore.setState({
    status: "logged-out",
    pauseCode: null,
    pausedSince: null,
    currentCampaignId: null,
    inboundGroupIds: [],
  });
}

function renderWidget() {
  return render(
    <Toaster>
      <AgentStateWidget />
    </Toaster>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentStateWidget", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders Offline badge when status is logged-out", () => {
    renderWidget();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("renders Ready badge when status is ready", () => {
    useAgentStore.setState({ status: "ready" });
    renderWidget();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders Paused badge and pause code when paused", () => {
    useAgentStore.setState({ status: "paused", pauseCode: "LUNCH" });
    renderWidget();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("(LUNCH)")).toBeInTheDocument();
  });

  it("renders On Call badge when busy", () => {
    useAgentStore.setState({ status: "busy" });
    renderWidget();
    expect(screen.getByText("On Call")).toBeInTheDocument();
  });

  it("status-badge button is disabled when status is busy", () => {
    useAgentStore.setState({ status: "busy" });
    renderWidget();
    const btn = screen.getByRole("button", { name: /agent state/i });
    expect(btn).toBeDisabled();
  });

  it("opens state menu on click when logged-out (shows Offline option)", async () => {
    useAgentStore.setState({ status: "logged-out" });
    renderWidget();
    const btn = screen.getByRole("button", { name: /agent state/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("menu", { name: /change agent state/i })).toBeInTheDocument();
    });
  });

  it("closes menu on Escape key", async () => {
    useAgentStore.setState({ status: "ready" });
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("PauseButton is rendered alongside state badge", () => {
    useAgentStore.setState({ status: "ready" });
    renderWidget();
    // PauseButton renders as "Pause" when status=ready
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  it("PauseButton shows Ready when agent is paused", () => {
    useAgentStore.setState({ status: "paused", pauseCode: "LUNCH" });
    renderWidget();
    expect(screen.getByRole("button", { name: /go ready/i })).toBeInTheDocument();
  });
});
