import { describe, it, expect, vi, beforeEach } from "vitest";
import { HotkeyRegistry } from "@/lib/hotkeys/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeyEvent(
  key: string,
  opts: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

function makeInputElement(tag: "INPUT" | "TEXTAREA" = "INPUT"): HTMLElement {
  return document.createElement(tag.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HotkeyRegistry", () => {
  let registry: HotkeyRegistry;

  beforeEach(() => {
    registry = new HotkeyRegistry();
  });

  it("registers a binding and fires handler on matching key", () => {
    const handler = vi.fn();
    registry.register({
      id: "test-f1",
      scope: "global",
      key: "F1",
      ignoreInputFocus: true,
      handler,
    });

    const handled = registry.fire(makeKeyEvent("F1"));
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not fire handler on non-matching key", () => {
    const handler = vi.fn();
    registry.register({
      id: "test-f2",
      scope: "global",
      key: "F2",
      ignoreInputFocus: true,
      handler,
    });

    const handled = registry.fire(makeKeyEvent("F1"));
    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("deregisters via returned cleanup fn", () => {
    const handler = vi.fn();
    const off = registry.register({
      id: "test-esc",
      scope: "global",
      key: "Escape",
      ignoreInputFocus: true,
      handler,
    });

    off();
    registry.fire(makeKeyEvent("Escape"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("fires higher-priority binding when two match same key", () => {
    const low = vi.fn();
    const high = vi.fn();

    registry.register({
      id: "low",
      scope: "global",
      key: "F3",
      ignoreInputFocus: true,
      priority: 0,
      handler: low,
    });
    registry.register({
      id: "high",
      scope: "global",
      key: "F3",
      ignoreInputFocus: true,
      priority: 10,
      handler: high,
    });

    registry.fire(makeKeyEvent("F3"));
    expect(high).toHaveBeenCalledOnce();
    expect(low).not.toHaveBeenCalled();
  });

  it("suppresses binding in input when ignoreInputFocus is false", () => {
    const handler = vi.fn();
    registry.register({
      id: "m-key",
      scope: "in-call",
      key: "m",
      ignoreInputFocus: false,
      handler,
    });

    // Simulate input focused
    const input = makeInputElement();
    document.body.appendChild(input);
    input.focus();

    registry.fire(makeKeyEvent("m"));
    expect(handler).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("fires binding in input when ignoreInputFocus is true", () => {
    const handler = vi.fn();
    registry.register({
      id: "f4-mute",
      scope: "global",
      key: "F4",
      ignoreInputFocus: true,
      handler,
    });

    const input = makeInputElement();
    document.body.appendChild(input);
    input.focus();

    registry.fire(makeKeyEvent("F4"));
    expect(handler).toHaveBeenCalledOnce();

    document.body.removeChild(input);
  });

  it("matches ctrl modifier binding only when ctrl is pressed", () => {
    const handler = vi.fn();
    registry.register({
      id: "ctrl-t",
      scope: "global",
      key: "t",
      ctrl: true,
      ignoreInputFocus: true,
      handler,
    });

    // Without ctrl — no match
    registry.fire(makeKeyEvent("t"));
    expect(handler).not.toHaveBeenCalled();

    // With ctrl — match
    registry.fire(makeKeyEvent("t", { ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("allows ctrl+key even when input focused (modifier bypass)", () => {
    const handler = vi.fn();
    registry.register({
      id: "ctrl-b",
      scope: "global",
      key: "b",
      ctrl: true,
      ignoreInputFocus: false,
      handler,
    });

    const input = makeInputElement();
    document.body.appendChild(input);
    input.focus();

    // ctrl key counts as a modifier → not suppressed
    registry.fire(makeKeyEvent("b", { ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();

    document.body.removeChild(input);
  });

  it("replaces binding with same id", () => {
    const first = vi.fn();
    const second = vi.fn();

    registry.register({ id: "dup", scope: "global", key: "F5", ignoreInputFocus: true, handler: first });
    registry.register({ id: "dup", scope: "global", key: "F5", ignoreInputFocus: true, handler: second });

    registry.fire(makeKeyEvent("F5"));
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("tracks size correctly", () => {
    expect(registry.size).toBe(0);
    const off = registry.register({ id: "sz1", scope: "global", key: "a", handler: vi.fn() });
    expect(registry.size).toBe(1);
    registry.register({ id: "sz2", scope: "global", key: "b", handler: vi.fn() });
    expect(registry.size).toBe(2);
    off();
    expect(registry.size).toBe(1);
  });

  it("destroy clears all bindings", () => {
    const handler = vi.fn();
    registry.register({ id: "d1", scope: "global", key: "F6", ignoreInputFocus: true, handler });
    registry.destroy();
    expect(registry.size).toBe(0);
    registry.fire(makeKeyEvent("F6"));
    expect(handler).not.toHaveBeenCalled();
  });
});
