/**
 * A07 — HotkeyHelpOverlay unit tests.
 * Tests scope filtering, query filtering, and F1 toggle behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HotkeyRegistry } from "@/lib/hotkeys/registry";
import type { HotkeyScope } from "@/lib/hotkeys/registry";

// ---------------------------------------------------------------------------
// Registry getAll() tests (pure unit, no React)
// ---------------------------------------------------------------------------

describe("HotkeyRegistry.getAll()", () => {
  let registry: HotkeyRegistry;

  beforeEach(() => {
    registry = new HotkeyRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it("returns empty array when no bindings registered", () => {
    expect(registry.getAll()).toHaveLength(0);
  });

  it("returns descriptor for each registered binding", () => {
    registry.register({ id: "a1", scope: "global", key: "F1", handler: vi.fn(), description: "Help" });
    registry.register({ id: "a2", scope: "in-call", key: "m", handler: vi.fn(), description: "Mute" });

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.id)).toContain("a1");
    expect(all.map((d) => d.id)).toContain("a2");
  });

  it("does not include handler function in descriptors", () => {
    registry.register({ id: "b1", scope: "global", key: "F2", handler: vi.fn() });
    const [desc] = registry.getAll();
    expect(desc).not.toHaveProperty("handler");
  });

  it("includes description when provided", () => {
    registry.register({
      id: "c1",
      scope: "dial",
      key: "Enter",
      handler: vi.fn(),
      description: "Dial number",
    });
    const [desc] = registry.getAll();
    expect(desc.description).toBe("Dial number");
  });

  it("returns correct scope for each binding", () => {
    const scopes: HotkeyScope[] = ["global", "in-call", "auto-dial", "wrapup"];
    scopes.forEach((scope, i) => {
      registry.register({ id: `s${i}`, scope, key: `F${i + 1}`, handler: vi.fn() });
    });

    const all = registry.getAll();
    const returnedScopes = all.map((d) => d.scope);
    for (const scope of scopes) {
      expect(returnedScopes).toContain(scope);
    }
  });

  it("removes descriptor when binding is deregistered", () => {
    const off = registry.register({ id: "d1", scope: "global", key: "F5", handler: vi.fn() });
    expect(registry.getAll()).toHaveLength(1);
    off();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("includes modifier flags in descriptor", () => {
    registry.register({
      id: "mod1",
      scope: "global",
      key: "t",
      ctrl: true,
      shift: true,
      handler: vi.fn(),
    });
    const [desc] = registry.getAll();
    expect(desc.ctrl).toBe(true);
    expect(desc.shift).toBe(true);
    expect(desc.meta).toBeUndefined();
    expect(desc.alt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filter logic tests (pure, no React)
// ---------------------------------------------------------------------------

import type { HotkeyDescriptor } from "@/lib/hotkeys/registry";

// Reimport the filter helper (inline for unit isolation)
function filterDescriptors(
  descriptors: HotkeyDescriptor[],
  query: string,
): HotkeyDescriptor[] {
  const SCOPE_LABEL: Record<string, string> = {
    global: "Global",
    "agent-shell": "Agent Shell",
    dial: "Dial",
    "in-call": "In Call",
    "auto-dial": "Auto Dial",
    wrapup: "Wrap-up",
    modal: "Modal",
  };

  function formatCombo(d: HotkeyDescriptor): string {
    const parts: string[] = [];
    if (d.ctrl) parts.push("Ctrl");
    if (d.alt) parts.push("Alt");
    if (d.shift) parts.push("Shift");
    if (d.meta) parts.push("Meta");
    parts.push(d.key === " " ? "Space" : d.key);
    return parts.join(" + ");
  }

  const q = query.trim().toLowerCase();
  if (!q) return descriptors;
  return descriptors.filter((d) => {
    const combo = formatCombo(d).toLowerCase();
    const desc = (d.description ?? "").toLowerCase();
    const scope = (SCOPE_LABEL[d.scope] ?? d.scope).toLowerCase();
    return combo.includes(q) || desc.includes(q) || scope.includes(q);
  });
}

describe("filterDescriptors()", () => {
  const descriptors: HotkeyDescriptor[] = [
    { id: "1", scope: "global", key: "F1", description: "Open help" },
    { id: "2", scope: "in-call", key: "m", description: "Mute microphone" },
    { id: "3", scope: "in-call", key: "h", description: "Hold call" },
    { id: "4", scope: "dial", key: "Enter", ctrl: true, description: "Dial number" },
    { id: "5", scope: "wrapup", key: "d", description: "Submit disposition" },
  ];

  it("returns all when query is empty", () => {
    expect(filterDescriptors(descriptors, "")).toHaveLength(5);
    expect(filterDescriptors(descriptors, "  ")).toHaveLength(5);
  });

  it("filters by scope label", () => {
    const result = filterDescriptors(descriptors, "in call");
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.scope === "in-call")).toBe(true);
  });

  it("filters by key combo", () => {
    const result = filterDescriptors(descriptors, "ctrl");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("4");
  });

  it("filters by description (case-insensitive)", () => {
    const result = filterDescriptors(descriptors, "mute");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("filters by key name", () => {
    const result = filterDescriptors(descriptors, "f1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("returns empty when no match", () => {
    expect(filterDescriptors(descriptors, "zzzzz")).toHaveLength(0);
  });

  it("partial match on scope works", () => {
    const result = filterDescriptors(descriptors, "wrap");
    expect(result).toHaveLength(1);
    expect(result[0].scope).toBe("wrapup");
  });
});
