"use client";

/**
 * A07 — HotkeyHelpOverlay
 * F1 globally opens a searchable modal listing all active registered hotkeys.
 * Scopes: global, agent-shell, dial, in-call, auto-dial, wrapup (and inherited global).
 * Live-filters by typing. Esc / F1 to close.
 */

import * as React from "react";
import { hotkeyRegistry, useHotkeys, type HotkeyDescriptor, type HotkeyScope } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_ORDER: HotkeyScope[] = [
  "global",
  "agent-shell",
  "dial",
  "in-call",
  "auto-dial",
  "wrapup",
  "modal",
];

const SCOPE_LABEL: Record<HotkeyScope, string> = {
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

function filterDescriptors(
  descriptors: HotkeyDescriptor[],
  query: string,
): HotkeyDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return descriptors;
  return descriptors.filter((d) => {
    const combo = formatCombo(d).toLowerCase();
    const desc = (d.description ?? "").toLowerCase();
    const scope = SCOPE_LABEL[d.scope].toLowerCase();
    return combo.includes(q) || desc.includes(q) || scope.includes(q);
  });
}

function sortDescriptors(descriptors: HotkeyDescriptor[]): HotkeyDescriptor[] {
  return [...descriptors].sort((a, b) => {
    const ai = SCOPE_ORDER.indexOf(a.scope);
    const bi = SCOPE_ORDER.indexOf(b.scope);
    const scopeDiff = (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    if (scopeDiff !== 0) return scopeDiff;
    return formatCombo(a).localeCompare(formatCombo(b));
  });
}

// ---------------------------------------------------------------------------
// KbdCombo — accessible keyboard shortcut display
// ---------------------------------------------------------------------------

function KbdCombo({ descriptor }: { descriptor: HotkeyDescriptor }) {
  const parts: string[] = [];
  if (descriptor.ctrl) parts.push("Ctrl");
  if (descriptor.alt) parts.push("Alt");
  if (descriptor.shift) parts.push("Shift");
  if (descriptor.meta) parts.push("Meta");
  parts.push(descriptor.key === " " ? "Space" : descriptor.key);

  return (
    <span className="flex items-center gap-0.5 font-mono">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span className="text-[var(--color-fg-muted)] text-xs px-0.5" aria-hidden="true">
              +
            </span>
          )}
          <kbd
            className={cn(
              "inline-flex items-center justify-center rounded border",
              "border-[var(--color-surface-border)] bg-[var(--color-surface-muted)]",
              "px-1.5 py-0.5 text-xs font-medium text-[var(--color-fg-default)]",
              "shadow-[0_1px_0_0_var(--color-surface-border)]",
            )}
          >
            {part}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// HotkeyHelpOverlay
// ---------------------------------------------------------------------------

export function HotkeyHelpOverlay(): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);

  // Register F1 globally
  useHotkeys(
    React.useMemo(
      () => [
        {
          scope: "global",
          key: "F1",
          ignoreInputFocus: true,
          priority: 100,
          description: "Open keyboard shortcuts help",
          handler: () => setOpen((v) => !v),
        },
      ],
      [],
    ),
  );

  // Save / restore focus on open/close
  React.useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement;
      // Auto-focus the search input
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQuery("");
      triggerRef.current?.focus();
      triggerRef.current = null;
    }
  }, [open]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open]);

  // Focus trap
  React.useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [open]);

  if (!open) return null;

  // Get current snapshot of all bindings
  const all = sortDescriptors(hotkeyRegistry.getAll());
  const filtered = filterDescriptors(all, query);

  // Group by scope for display
  const grouped = new Map<HotkeyScope, HotkeyDescriptor[]>();
  for (const d of filtered) {
    if (!grouped.has(d.scope)) grouped.set(d.scope, []);
    grouped.get(d.scope)!.push(d);
  }

  const scopeEntries = SCOPE_ORDER.filter((s) => grouped.has(s));
  // Add any scopes not in our order list
  for (const [s] of grouped) {
    if (!SCOPE_ORDER.includes(s)) scopeEntries.push(s);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />

      {/* Modal */}
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hk-overlay-title"
        className={cn(
          "relative z-10 flex w-full max-w-2xl flex-col",
          "max-h-[80vh] rounded-[var(--radius-card)]",
          "border border-[var(--color-surface-border)]",
          "bg-[var(--color-surface-elevated)] shadow-xl",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-surface-border)] px-5 py-4">
          <h2
            id="hk-overlay-title"
            className="text-base font-semibold text-[var(--color-fg-default)]"
          >
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close keyboard shortcuts"
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-fg-muted)]",
              "hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg-default)] transition-colors",
            )}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L7 5.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L8.06 7l3.72 3.72a.75.75 0 1 1-1.06 1.06L7 8.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L5.94 7 2.22 3.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-[var(--color-surface-border)] px-5 py-3">
          <Input
            ref={inputRef}
            type="search"
            placeholder="Filter by key, description, or scope…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter keyboard shortcuts"
            aria-controls="hk-results"
          />
        </div>

        {/* Results */}
        <div
          id="hk-results"
          className="flex-1 overflow-y-auto"
          aria-live="polite"
          aria-atomic="false"
        >
          {filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-[var(--color-fg-muted)]">
              No shortcuts match &quot;{query}&quot;
            </div>
          ) : (
            <table className="w-full border-collapse" role="table">
              <tbody>
                {scopeEntries.map((scope) => {
                  const items = grouped.get(scope) ?? [];
                  return (
                    <React.Fragment key={scope}>
                      <tr
                        role="row"
                        className="bg-[var(--color-surface-muted)]"
                      >
                        <td
                          colSpan={3}
                          className="px-5 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]"
                          role="columnheader"
                        >
                          {SCOPE_LABEL[scope] ?? scope}
                        </td>
                      </tr>
                      {items.map((d) => (
                        <tr
                          key={d.id}
                          role="row"
                          className="border-b border-[var(--color-surface-border)] last:border-0 hover:bg-[var(--color-surface-muted)] transition-colors"
                        >
                          <td
                            className="w-48 px-5 py-2.5"
                            role="cell"
                          >
                            <KbdCombo descriptor={d} />
                          </td>
                          <td
                            className="flex-1 px-5 py-2.5 text-sm text-[var(--color-fg-default)]"
                            role="cell"
                          >
                            {d.description ?? d.id}
                          </td>
                          <td
                            className="px-5 py-2.5 text-right"
                            role="cell"
                          >
                            <span className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5",
                              "text-xs font-medium",
                              "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]",
                            )}>
                              {SCOPE_LABEL[d.scope] ?? d.scope}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--color-surface-border)] px-5 py-3">
          <span className="text-xs text-[var(--color-fg-muted)]">
            {filtered.length} shortcut{filtered.length !== 1 ? "s" : ""}
            {query && ` matching "${query}"`}
          </span>
          <span className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <kbd className="rounded border border-[var(--color-surface-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs">
              Esc
            </kbd>
            or
            <kbd className="rounded border border-[var(--color-surface-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs">
              F1
            </kbd>
            to close
          </span>
        </div>
      </div>
    </div>
  );
}
