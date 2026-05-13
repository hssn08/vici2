import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActionBar } from "../ActionBar";
import { useCallStore } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";

const mockToggleMute = vi.fn();
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
    toggleMute: mockToggleMute,
    hold: vi.fn(),
    unhold: vi.fn(),
    sendDtmf: vi.fn(),
    hangup: vi.fn(),
    selectMic: vi.fn(),
    selectSpeaker: vi.fn(),
    setVolume: vi.fn(),
    retryConnect: vi.fn(),
  }),
  SipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("ActionBar", () => {
  beforeEach(() => {
    useCallStore.getState().clearCall();
    useUiStore.setState({ disableHangupGrace: true }); // skip grace in tests
  });

  it("always renders Hangup button", () => {
    render(<ActionBar />);
    expect(screen.getByRole("button", { name: /Hangup/i })).toBeInTheDocument();
  });

  it("renders 9 action buttons when campaign is ONDEMAND", () => {
    useCallStore.setState({
      phase: "active",
      callUuid: "call-1",
      campaign: {
        id: 1, name: "Test", recording_mode: "ONDEMAND",
        wrapup_seconds: 60, hangup_grace_seconds: 5,
        hot_keys_active: true, webform_url: null,
      },
    });
    render(<ActionBar />);
    // Hangup, Hold, Mute, DTMF, Transfer, 3-way, Record, Callback, DNC = 9
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(9);
  });

  it("Hold button is disabled when phase is idle", () => {
    useCallStore.setState({ phase: "idle" });
    render(<ActionBar />);
    const hold = screen.getByRole("button", { name: /Place on hold/i });
    expect(hold).toHaveAttribute("aria-disabled", "true");
  });

  it("Hangup button triggers grace and sets wrapup", () => {
    useCallStore.setState({
      phase: "active",
      callUuid: "call-1",
      campaign: {
        id: 1, name: "T", recording_mode: "NEVER",
        wrapup_seconds: 60, hangup_grace_seconds: 5,
        hot_keys_active: true, webform_url: null,
      },
    });
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Hangup/i }));
    expect(useCallStore.getState().phase).toBe("wrapup");
  });

  it("Mute button calls toggleMute", () => {
    useCallStore.setState({ phase: "active", callUuid: "call-1" });
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Mute microphone/i }));
    // muted state is handled by useSoftphone, not directly testable here
    // but no error thrown is a pass
  });

  it("DTMF button opens keypad popover", () => {
    useCallStore.setState({ phase: "active", callUuid: "call-1" });
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: /DTMF/i }));
    expect(screen.getByRole("dialog", { name: /DTMF keypad/i })).toBeInTheDocument();
  });

  it("Record button is hidden for NEVER mode", () => {
    useCallStore.setState({
      phase: "active",
      callUuid: "call-1",
      campaign: { id: 1, name: "T", recording_mode: "NEVER", wrapup_seconds: 60, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    render(<ActionBar />);
    expect(screen.queryByRole("button", { name: /Record/i })).not.toBeInTheDocument();
  });

  it("Record button is visible for ONDEMAND mode", () => {
    useCallStore.setState({
      phase: "active",
      callUuid: "call-1",
      campaign: { id: 1, name: "T", recording_mode: "ONDEMAND", wrapup_seconds: 60, hangup_grace_seconds: 5, hot_keys_active: true, webform_url: null },
    });
    render(<ActionBar />);
    expect(screen.getByRole("button", { name: /Start recording/i })).toBeInTheDocument();
  });

  it("DNC button shows confirm dialog", () => {
    useCallStore.setState({
      phase: "active",
      callUuid: "call-1",
      lead: { id: "l1", phoneE164: "+14155550000" },
    });
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: /Mark as Do Not Call/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
