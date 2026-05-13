import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import * as React from "react";
import { AgentStateWidget } from "../AgentStateWidget";
import { useAgentStore } from "@/lib/stores/agent";

// ---------------------------------------------------------------------------
// Mock agent API
// ---------------------------------------------------------------------------

vi.mock("@/lib/agent", () => ({
  getAgentState: vi.fn(),
  setAgentState: vi.fn().mockResolvedValue({
    status: "ready",
    pauseCode: null,
    pausedSince: null,
    currentCampaignId: null,
  }),
  getPauseCodes: vi.fn().mockResolvedValue([
    { code: "LUNCH", label: "Lunch Break" },
    { code: "TRAIN", label: "Training", billable: true },
    { code: "MANUAL", label: "Manual Break" },
  ]),
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
    render(<AgentStateWidget />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("renders Ready badge when status is ready", () => {
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders Paused badge and pause code when paused", () => {
    useAgentStore.setState({ status: "paused", pauseCode: "LUNCH" });
    render(<AgentStateWidget />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("(LUNCH)")).toBeInTheDocument();
  });

  it("renders On Call badge when busy", () => {
    useAgentStore.setState({ status: "busy" });
    render(<AgentStateWidget />);
    expect(screen.getByText("On Call")).toBeInTheDocument();
  });

  it("button is disabled when status is busy", () => {
    useAgentStore.setState({ status: "busy" });
    render(<AgentStateWidget />);
    const btn = screen.getByRole("button", { name: /agent state/i });
    expect(btn).toBeDisabled();
  });

  it("opens state menu on click when ready", async () => {
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);
    const btn = screen.getByRole("button", { name: /agent state/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("menu", { name: /change agent state/i })).toBeInTheDocument();
    });
  });

  it("clicking Ready in menu calls setAgentState with ready", async () => {
    const { setAgentState } = await import("@/lib/agent");
    useAgentStore.setState({ status: "paused", pauseCode: "LUNCH" });
    render(<AgentStateWidget />);

    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));

    const readyBtn = screen.getByRole("menuitem", { name: /ready/i });
    await act(async () => {
      fireEvent.click(readyBtn);
    });

    await waitFor(() => {
      expect(setAgentState).toHaveBeenCalledWith({ status: "ready" });
    });
  });

  it("clicking Paused opens pause code picker", async () => {
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);

    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));

    fireEvent.click(screen.getByRole("menuitem", { name: /paused/i }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /pause reason/i })).toBeInTheDocument();
    });
  });

  it("pause code picker renders codes from API", async () => {
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);

    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /paused/i }));

    await waitFor(() => {
      expect(screen.getByText("Lunch Break")).toBeInTheDocument();
      expect(screen.getByText("Training")).toBeInTheDocument();
      expect(screen.getByText("Manual Break")).toBeInTheDocument();
    });
  });

  it("selecting a pause code calls setAgentState", async () => {
    const { setAgentState } = await import("@/lib/agent");
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);

    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /paused/i }));
    await waitFor(() => screen.getByText("Lunch Break"));

    await act(async () => {
      fireEvent.click(screen.getByText("Lunch Break"));
    });

    await waitFor(() => {
      expect(setAgentState).toHaveBeenCalledWith({
        status: "paused",
        pauseCode: "LUNCH",
      });
    });
  });

  it("closes menu on Escape key", async () => {
    useAgentStore.setState({ status: "ready" });
    render(<AgentStateWidget />);
    fireEvent.click(screen.getByRole("button", { name: /agent state/i }));
    await waitFor(() => screen.getByRole("menu"));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});
