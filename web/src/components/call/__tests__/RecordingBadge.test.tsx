import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecordingBadge } from "../RecordingBadge";
import { useCallStore } from "@/lib/stores/call";

describe("RecordingBadge", () => {
  beforeEach(() => {
    useCallStore.getState().clearCall();
  });

  it("shows REC OFF when not recording", () => {
    useCallStore.setState({ recording: "off" });
    render(<RecordingBadge />);
    expect(screen.getByRole("button")).toHaveTextContent("REC OFF");
  });

  it("shows REC when recording is on", () => {
    useCallStore.setState({ recording: "on" });
    render(<RecordingBadge />);
    expect(screen.getByRole("button")).toHaveTextContent("REC");
  });

  it("shows REC PAUSED when paused", () => {
    useCallStore.setState({ recording: "paused" });
    render(<RecordingBadge />);
    expect(screen.getByRole("button")).toHaveTextContent("REC PAUSED");
  });

  it("shows CONSENT when pending", () => {
    useCallStore.setState({ recording: "pending" });
    render(<RecordingBadge />);
    expect(screen.getByRole("button")).toHaveTextContent("CONSENT");
  });

  it("opens popover on click and shows file path as Stored securely", () => {
    useCallStore.setState({ recording: "on" });
    render(<RecordingBadge />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Stored securely");
  });
});
