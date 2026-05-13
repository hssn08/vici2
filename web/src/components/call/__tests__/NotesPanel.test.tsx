import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NotesPanel } from "../NotesPanel";
import { useCallStore } from "@/lib/stores/call";

// Mock apiFetch
const mockApiFetch = vi.fn().mockResolvedValue({});
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe("NotesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCallStore.getState().clearCall();
    useCallStore.setState({ callUuid: "call-uuid-1", notes: "" });
  });

  it("renders textarea with label", () => {
    render(<NotesPanel />);
    expect(screen.getByLabelText(/Notes/i)).toBeInTheDocument();
  });

  it("shows quick-tag chips", () => {
    render(<NotesPanel />);
    const chips = screen.getAllByRole("button");
    const chipLabels = chips.map((b) => b.textContent);
    expect(chipLabels).toContain("[callback]");
    expect(chipLabels).toContain("[interested]");
    expect(chipLabels).toContain("[not-interested]");
    expect(chipLabels).toContain("[wrong-person]");
  });

  it("inserts tag on chip click", () => {
    render(<NotesPanel />);
    const chip = screen.getAllByRole("button").find(
      (b) => b.textContent === "[callback]",
    )!;
    fireEvent.click(chip);
    const textarea = screen.getByLabelText(/Notes/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain("[callback]");
  });

  it("removes tag on second chip click", () => {
    render(<NotesPanel />);
    const chip = screen.getAllByRole("button").find(
      (b) => b.textContent === "[callback]",
    )!;
    fireEvent.click(chip);
    fireEvent.click(chip);
    const textarea = screen.getByLabelText(/Notes/i) as HTMLTextAreaElement;
    expect(textarea.value).not.toContain("[callback]");
  });

  it("enforces max length of 4096", () => {
    render(<NotesPanel />);
    const textarea = screen.getByLabelText(/Notes/i) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("maxLength", "4096");
  });

  it("auto-saves after 2s debounce", async () => {
    vi.useFakeTimers();
    try {
      render(<NotesPanel />);
      const textarea = screen.getByLabelText(/Notes/i) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "test note" } });
      expect(mockApiFetch).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(2100);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/agent/call/call-uuid-1/notes",
        expect.objectContaining({ method: "PATCH" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves immediately on blur", async () => {
    render(<NotesPanel />);
    const textarea = screen.getByLabelText(/Notes/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "blur note" } });
    await act(async () => {
      fireEvent.blur(textarea);
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalled();
  });
});
