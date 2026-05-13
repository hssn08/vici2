import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { DispositionPicker } from "../DispositionPicker";
import { useCallStore } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";

const MOCK_STATUSES = [
  { code: "SALE", label: "Sale", hotkey: "1", selectable: true },
  { code: "NI", label: "Not Interested", hotkey: "2", selectable: true },
  { code: "NA", label: "No Answer", hotkey: "5", selectable: true },
];

const mockApiFetch = vi.fn().mockImplementation((path: string) => {
  if (path.includes("/statuses")) return Promise.resolve(MOCK_STATUSES);
  return Promise.resolve({ ok: true });
});

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock("@/lib/sip", () => ({
  useSoftphone: () => ({
    status: "on-call",
    registered: true,
    error: null,
    muted: false,
    onHold: false,
    micPermission: "granted",
    audioInputs: [],
    audioOutputs: [],
    stats: null,
    mute: vi.fn(),
    unmute: vi.fn(),
    hold: vi.fn(),
    unhold: vi.fn(),
    sendDtmf: vi.fn(),
    hangup: vi.fn(),
    selectMic: vi.fn(),
    selectSpeaker: vi.fn(),
    setVolume: vi.fn(),
    retryConnect: vi.fn(),
  }),
}));

const defaultCampaign = {
  id: 1, name: "T", recording_mode: "NEVER" as const,
  wrapup_seconds: 60, hangup_grace_seconds: 5,
  hot_keys_active: true, webform_url: null,
};

describe("DispositionPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCallStore.getState().clearCall();
    useUiStore.setState({ confirmHotkeyDispo: false, disableHangupGrace: false });
  });

  it("does not render when phase is not wrapup", () => {
    useCallStore.setState({ phase: "active" });
    render(<DispositionPicker />);
    expect(screen.queryByLabelText(/Disposition/i)).not.toBeInTheDocument();
  });

  it("renders when phase is wrapup", () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    expect(screen.getByLabelText(/Disposition/i)).toBeInTheDocument();
  });

  it("loads and displays status tiles", async () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    await waitFor(() => {
      expect(screen.getByText("SALE")).toBeInTheDocument();
      expect(screen.getByText("NI")).toBeInTheDocument();
    });
  });

  it("shows Submit button", () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    expect(screen.getByRole("button", { name: /Submit/i })).toBeInTheDocument();
  });

  it("shows Cancel & resume when grace is active", () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      hangupGraceActive: true,
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    expect(screen.getByText(/Cancel.*resume/i)).toBeInTheDocument();
  });

  it("notes pre-filled from store", async () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      notes: "my notes",
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    await waitFor(() => {
      const textarea = screen.getByLabelText("Notes") as HTMLTextAreaElement;
      expect(textarea.value).toBe("my notes");
    });
  });

  it("shows Schedule Callback button (A08)", () => {
    useCallStore.setState({
      phase: "wrapup",
      callUuid: "call-1",
      wrapupStartAt: Date.now(),
      campaign: defaultCampaign,
    });
    render(<DispositionPicker />);
    // A08 replaced the inline checkbox+datetime with a button that opens CallbackPicker modal
    expect(
      screen.getByRole("button", { name: /Schedule Callback/i }),
    ).toBeInTheDocument();
  });
});
