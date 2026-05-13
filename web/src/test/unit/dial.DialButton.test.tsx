import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DialButton } from "@/components/dial/DialButton";
import type { ClientGates } from "@/lib/stores/dial";

const ALL_PASS: ClientGates = {
  phoneValid: true,
  tcpaHint: "allow",
  dncHint: "clear",
  agentReady: true,
  noInFlight: true,
  campaignActive: true,
};

describe("DialButton", () => {
  it("is clickable when all gates pass", () => {
    const onCall = vi.fn();
    render(<DialButton gates={ALL_PASS} onCall={onCall} />);
    fireEvent.click(screen.getByRole("button", { name: /call/i }));
    expect(onCall).toHaveBeenCalledOnce();
  });

  it("uses aria-disabled (not HTML disabled) when DNC hit", () => {
    const gates: ClientGates = { ...ALL_PASS, dncHint: "hit" };
    render(<DialButton gates={gates} onCall={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /call/i });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    // Must NOT have native disabled attribute so it stays in tab order
    expect(btn).not.toBeDisabled();
  });

  it("shows TCPA inline error when outside window", () => {
    const gates: ClientGates = { ...ALL_PASS, tcpaHint: "skip_until" };
    render(<DialButton gates={gates} onCall={vi.fn()} />);
    expect(screen.getByText(/outside calling window/i)).toBeDefined();
  });

  it("calls onAnnounce when aria-disabled button clicked", () => {
    const gates: ClientGates = { ...ALL_PASS, agentReady: false };
    const onAnnounce = vi.fn();
    render(<DialButton gates={gates} onCall={vi.fn()} onAnnounce={onAnnounce} />);
    fireEvent.click(screen.getByRole("button", { name: /call/i }));
    expect(onAnnounce).toHaveBeenCalledWith(expect.stringContaining("pause"));
  });

  it("DNC_HIT has highest priority over INVALID_PHONE", () => {
    const gates: ClientGates = {
      ...ALL_PASS,
      dncHint: "hit",
      phoneValid: false,
    };
    render(<DialButton gates={gates} onCall={vi.fn()} />);
    expect(screen.getByText(/federal DNC/i)).toBeDefined();
  });

  it("shows loading spinner and Calling… text when loading", () => {
    render(<DialButton gates={ALL_PASS} onCall={vi.fn()} loading />);
    expect(screen.getByText(/calling/i)).toBeDefined();
  });
});
