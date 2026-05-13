"use client";

import * as React from "react";
import { useAgentStore, type AgentStatus } from "@/lib/stores/agent";
import { setAgentState } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PauseButton } from "@/components/call/PauseButton";
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

// States the agent can manually transition to from the state menu
// (pause is handled by PauseButton; ready is handled by PauseButton unpause).
const NON_PAUSE_STATES: AgentStatus[] = ["logged-out"];

// ---------------------------------------------------------------------------
// StateMenu (popover for non-pause manual transitions)
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
      {NON_PAUSE_STATES.map((s) => (
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
  const setStatus = useAgentStore((s) => s.setStatus);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [transitioning, setTransitioning] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
  React.useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [menuOpen]);

  const handleStateSelect = async (next: AgentStatus) => {
    const prev = status;
    setStatus(next);

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

  const tone = STATUS_TONE[status];
  // Badge component only accepts these tones:
  const badgeTone =
    tone === "brand"
      ? "neutral"
      : (tone as "neutral" | "success" | "warning" | "danger");

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {/* Status badge button — opens menu for logged-out transition */}
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

      {/* PauseButton handles pause/unpause transitions (A09) */}
      <PauseButton
        disabled={status === "busy" || status === "wrapup" || transitioning}
        size="sm"
      />

      {menuOpen ? (
        <StateMenu
          current={status}
          onSelect={handleStateSelect}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </div>
  );
}
