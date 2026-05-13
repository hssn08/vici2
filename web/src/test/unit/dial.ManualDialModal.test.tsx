import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ManualDialModal } from "@/components/dial/ManualDialModal";

describe("ManualDialModal", () => {
  it("renders when open=true", () => {
    render(
      <ManualDialModal open onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByLabelText(/phone number/i)).toBeDefined();
  });

  it("does not render dialog when open=false", () => {
    render(
      <ManualDialModal open={false} onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onSubmit with E.164 number on valid submit", () => {
    const onSubmit = vi.fn();
    render(
      <ManualDialModal open onOpenChange={vi.fn()} onSubmit={onSubmit} />,
    );
    const input = screen.getByLabelText(/phone number/i);
    fireEvent.change(input, { target: { value: "+14155551234" } });
    fireEvent.click(screen.getByRole("button", { name: /preview lead/i }));
    expect(onSubmit).toHaveBeenCalledWith("+14155551234");
  });

  it("shows validation error on invalid phone after blur", () => {
    render(
      <ManualDialModal open onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const input = screen.getByLabelText(/phone number/i);
    fireEvent.change(input, { target: { value: "not-a-phone" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("does not call onSubmit with invalid phone", () => {
    const onSubmit = vi.fn();
    render(
      <ManualDialModal open onOpenChange={vi.fn()} onSubmit={onSubmit} />,
    );
    const input = screen.getByLabelText(/phone number/i);
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: /preview lead/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Cancel button closes the modal", () => {
    const onOpenChange = vi.fn();
    render(
      <ManualDialModal open onOpenChange={onOpenChange} onSubmit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
