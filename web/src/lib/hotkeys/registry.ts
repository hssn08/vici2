"use client";

export type HotkeyScope = "global" | "in-call" | "wrapup" | "modal" | "auto-dial" | "agent-shell" | "dial";

export interface HotkeyBinding {
  id: string;
  scope: HotkeyScope;
  /** Key value as returned by KeyboardEvent.key, e.g. "F1", "m", "Escape", " " */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * When true, fires even when an input / textarea / contenteditable is focused.
   * Default: false (suppressed in inputs).
   */
  ignoreInputFocus?: boolean;
  /**
   * Higher priority wins when multiple bindings match the same key combination.
   * Default: 0.
   */
  priority?: number;
  /** Human-readable description shown in the hotkey help overlay. */
  description?: string;
  handler: (e: KeyboardEvent) => void;
}

/** Read-only descriptor for display purposes (no handler reference). */
export interface HotkeyDescriptor {
  id: string;
  scope: HotkeyScope;
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  description?: string;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (el as HTMLElement).isContentEditable
  );
}

function matchesModifiers(
  e: KeyboardEvent,
  binding: HotkeyBinding,
): boolean {
  if (binding.ctrl !== undefined && binding.ctrl !== e.ctrlKey) return false;
  if (binding.meta !== undefined && binding.meta !== e.metaKey) return false;
  if (binding.shift !== undefined && binding.shift !== e.shiftKey) return false;
  if (binding.alt !== undefined && binding.alt !== e.altKey) return false;
  return true;
}

/**
 * Global hotkey registry.
 *
 * Usage:
 *   const off = hotkeyRegistry.register({ id: 'my-key', scope: 'global', key: 'F1', handler })
 *   // later:
 *   off();
 *
 * The registry is a singleton — one keydown listener on document handles all
 * registered bindings. Components register/deregister on mount/unmount.
 */
export class HotkeyRegistry {
  private bindings: Map<string, HotkeyBinding> = new Map();
  private listener: ((e: KeyboardEvent) => void) | null = null;
  private listenerCount = 0;

  /**
   * Register a binding. Returns a function that deregisters it.
   */
  register(binding: HotkeyBinding): () => void {
    if (this.bindings.has(binding.id)) {
      // Replace existing binding with same id
      this.bindings.delete(binding.id);
    }
    this.bindings.set(binding.id, { priority: 0, ...binding });
    this.ensureListener();
    return () => this.unregister(binding.id);
  }

  unregister(id: string): void {
    this.bindings.delete(id);
  }

  /**
   * Returns display descriptors for all currently-registered bindings.
   * Safe to call from render — no handler references included.
   */
  getAll(): HotkeyDescriptor[] {
    return Array.from(this.bindings.values()).map(
      ({ id, scope, key, ctrl, meta, shift, alt, description }) => ({
        id,
        scope,
        key,
        ctrl,
        meta,
        shift,
        alt,
        description,
      }),
    );
  }

  /**
   * Manually fire a binding by key event (used by tests).
   * Returns true if a binding handled the event.
   */
  fire(e: KeyboardEvent): boolean {
    return this.handleKeyDown(e);
  }

  /** For tests: how many bindings are registered */
  get size(): number {
    return this.bindings.size;
  }

  private ensureListener(): void {
    if (this.listener) return;
    this.listener = (e: KeyboardEvent) => this.handleKeyDown(e);
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", this.listener);
    }
  }

  /** Remove the document listener (call when registry is destroyed). */
  destroy(): void {
    if (this.listener && typeof document !== "undefined") {
      document.removeEventListener("keydown", this.listener);
    }
    this.listener = null;
    this.bindings.clear();
  }

  private handleKeyDown(e: KeyboardEvent): boolean {
    const inputFocused = isInputFocused();
    const hasModifier = e.ctrlKey || e.altKey || e.metaKey;

    // Collect all matches sorted by priority descending
    const matches: HotkeyBinding[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.key !== e.key) continue;
      if (!matchesModifiers(e, binding)) continue;

      // Suppress in inputs unless ignoreInputFocus or modifier key pressed
      if (inputFocused && !binding.ignoreInputFocus && !hasModifier) {
        continue;
      }

      matches.push(binding);
    }

    if (matches.length === 0) return false;

    // Sort by priority descending
    matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    e.preventDefault();
    matches[0].handler(e);
    return true;
  }
}

/** Singleton registry — shared across the whole application. */
export const hotkeyRegistry = new HotkeyRegistry();
