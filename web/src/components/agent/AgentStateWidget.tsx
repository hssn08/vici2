"use client";

import * as React from "react";
import { useAgentStore, type AgentStatus } from "@/lib/stores/agent";
import { setAgentState, getPauseCodes, type PauseCode } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<AgentStatus, string> = {
  "logged-out": "Offline",
  ready: "Ready",
  paused: "Paused",
  busy: "On Call",
  wrapup: "Wrap-up",
};

const STATUS_TONE: Record<
  AgentStatus,
  "neutral" | "success" | "warning" | "danger" | "brand"
> = {
  "logged-out": "neutral",
  ready: "success",
  paused: "warning",
  busy: "brand",
  wrapup: "warning",
};

// States the agent can manually transition to (not busy/wrapup — those are
// driven by telephony events).
const MANUAL_STATES: AgentStatus[] = ["ready", "paused", "logged-out"];

// ---------------------------------------------------------------------------
// PauseCodePicker (inline sub-component)
// ---------------------------------------------------------------------------

interface PauseCodePickerProps {
  onSelect: (code: string) => void;
  onCancel: () => void;
}

function PauseCodePicker({
  onSelect,
  onCancel,
}: PauseCodePickerProps): React.ReactElement {
  const [codes, setCodes] = React.useState<PauseCode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    getPauseCodes()
      .then((data) => {
        if (!cancelled) {
          setCodes(
            data.length > 0
              ? data
              : [{ code: "MANUAL", label: "Manual Break" }],
          );
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Fallback to a default pause code on error
          setCodes([{ code: "MANUAL", label: "Manual Break" }]);
          setError("Could not load pause codes");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Select pause reason"
      className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-md border bg-[var(--color-surface-elevated)] p-1 shadow-lg"
    >
      {error ? (
        <p className="px-2 py-1 text-xs text-[var(--color-fg-muted)]">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="px-2 py-1 text-xs text-[var(--color-fg-muted)]">
          Loading…
        </p>
      ) : (
        <ul role="listbox" aria-label="Pause reasons">
          {codes.map((pc) => (
            <li key={pc.code} role="option" aria-selected={false}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-muted)] focus:outline-none focus-visible:ring-2"
                onClick={() => onSelect(pc.code)}
              >
                {pc.label}
                {pc.billable ? (
                  <span className="ml-1 text-xs text-[var(--color-fg-muted)]">
                    (billable)
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <hr className="my-1 border-[var(--color-surface-border)]" />
      <button
        type="button"
        className="w-full rounded px-2 py-1.5 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StateMenu (popover with available transitions)
// ---------------------------------------------------------------------------

interface StateMenuProps {
  current: AgentStatus;
  onSelect: (status: AgentStatus) => void;
  onClose: () => void;
}

function StateMenu({
  current,
  onSelect,
  onClose,
}: StateMenuProps): React.ReactElement {
  return (
    <div
      role="menu"
      aria-label="Change agent state"
      className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border bg-[var(--color-surface-elevated)] p-1 shadow-lg"
    >
      {MANUAL_STATES.map((s) => (
        <button
          key={s}
          type="button"
          role="menuitem"
          aria-current={current === s ? "true" : undefined}
          className={cn(
            "w-full rounded px-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2",
            current === s
              ? "bg-[var(--color-surface-muted)] font-medium"
              : "hover:bg-[var(--color-surface-muted)]",
          )}
          onClick={() => {
            onSelect(s);
            onClose();
          }}
          disabled={current === s}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentStateWidget
// ---------------------------------------------------------------------------

export function AgentStateWidget(): React.ReactElement {
  const status = useAgentStore((s) => s.status);
  const pauseCode = useAgentStore((s) => s.pauseCode);
  const setPause = useAgentStore((s) => s.setPause);
  const clearPause = useAgentStore((s) => s.clearPause);
  const setStatus = useAgentStore((s) => s.setStatus);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [pickingPause, setPickingPause] = React.useState(false);
  const [transitioning, setTransitioning] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
  React.useEffect(() => {
    if (!menuOpen && !pickingPause) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setPickingPause(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
        setPickingPause(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [menuOpen, pickingPause]);

  const handleStateSelect = async (next: AgentStatus) => {
    if (next === "paused") {
      // Need a pause code — open picker
      setPickingPause(true);
      return;
    }

    const prev = status;
    // Optimistic update
    if (next === "ready") {
      clearPause();
    } else {
      setStatus(next);
    }

    setTransitioning(true);
    try {
      await setAgentState({ status: next });
    } catch {
      // Rollback
      setStatus(prev);
    } finally {
      setTransitioning(false);
    }
  };

  const handlePauseCodeSelect = async (code: string) => {
    setPickingPause(false);
    const prev = status;
    // Optimistic
    setPause(code);

    setTransitioning(true);
    try {
      await setAgentState({ status: "paused", pauseCode: code });
    } catch {
      setStatus(prev);
    } finally {
      setTransitioning(false);
    }
  };

  const tone = STATUS_TONE[status];
  // Badge component only accepts these tones:
  const badgeTone =
    tone === "brand" ? "neutral" : (tone as "neutral" | "success" | "warning" | "danger");

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Agent state: ${STATUS_LABEL[status]}. Click to change.`}
        disabled={
          transitioning || status === "busy" || status === "wrapup"
        }
        onClick={() => {
          setMenuOpen((o) => !o);
          setPickingPause(false);
        }}
        className="gap-1.5 px-2"
      >
        <Badge tone={badgeTone} className="pointer-events-none">
          {STATUS_LABEL[status]}
        </Badge>
        {status === "paused" && pauseCode ? (
          <span className="text-xs text-[var(--color-fg-muted)]">
            ({pauseCode})
          </span>
        ) : null}
        <span aria-hidden className="text-[var(--color-fg-muted)]">
          ▾
        </span>
      </Button>

      {menuOpen && !pickingPause ? (
        <StateMenu
          current={status}
          onSelect={handleStateSelect}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {pickingPause ? (
        <PauseCodePicker
          onSelect={handlePauseCodeSelect}
          onCancel={() => {
            setPickingPause(false);
            setMenuOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
