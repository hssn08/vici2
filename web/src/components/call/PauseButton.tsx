"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useAgentState, PauseValidationError } from "@/lib/agent/useAgentState";
import { useUiStore } from "@/lib/stores/ui";
import { useNotify } from "@/lib/hooks/useNotify";
import { useHotkeys } from "@/lib/hotkeys/useHotkeys";
import { PauseCodeMenu } from "./PauseCodeMenu";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PauseButtonProps {
  /** Disable button (e.g. agent is busy / in-call) */
  disabled?: boolean;
  /** Size variant */
  size?: "sm" | "md";
}

// ---------------------------------------------------------------------------
// PauseButton
// ---------------------------------------------------------------------------

export function PauseButton({
  disabled,
  size = "sm",
}: PauseButtonProps): React.ReactElement {
  const {
    status,
    pauseConfig,
    transitioning,
    pause,
    unpause,
  } = useAgentState();

  const lastUsedPauseCode = useUiStore((s) => s.lastUsedPauseCode);
  const notify = useNotify();

  const [menuOpen, setMenuOpen] = React.useState(false);

  const isPaused = status === "paused";
  const isReady = status === "ready" || status === "wrapup";
  const isBusy = status === "busy";
  const isDisabled =
    disabled ||
    transitioning ||
    isBusy ||
    // Prevent action when menu is already open
    (menuOpen && !isPaused);

  // ---- Hotkey: Ctrl+P ----
  useHotkeys(
    React.useMemo(
      () => [
        {
          scope: "agent-shell" as const,
          key: "p",
          ctrl: true,
          ignoreInputFocus: true,
          priority: 10,
          description: "Toggle pause / go ready (Ctrl+P)",
          handler: () => {
            if (menuOpen) return; // don't double-trigger if menu already open
            if (isPaused) {
              void handleUnpause();
            } else if (isReady) {
              void handlePauseClick();
            }
          },
        },
      ],
      [isPaused, isReady, menuOpen, pauseConfig.pauseCodesRequired],
    ),
  );

  // ---- Handlers ----

  const handlePauseClick = async () => {
    if (pauseConfig.pauseCodesRequired === "OFF") {
      try {
        await pause(null);
      } catch (err) {
        notify.danger({ title: err instanceof Error ? err.message : "Failed to pause" });
      }
    } else {
      setMenuOpen(true);
    }
  };

  const handleUnpause = async () => {
    try {
      await unpause();
    } catch (err) {
      notify.danger({ title: err instanceof Error ? err.message : "Failed to go ready" });
    }
  };

  const handleMenuSelect = async (
    code: string | null,
    freeText?: string | null,
  ) => {
    setMenuOpen(false);
    try {
      await pause(code, freeText);
    } catch (err) {
      if (err instanceof PauseValidationError) {
        notify.warning({ title: err.message });
      } else {
        notify.danger({
          title: err instanceof Error ? err.message : "Failed to pause",
        });
      }
    }
  };

  const handleMenuCancel = () => {
    setMenuOpen(false);
  };

  // ---- Render ----

  const buttonLabel = isPaused ? "Ready" : "Pause";
  const buttonVariant = isPaused ? "primary" : "secondary";

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={size}
        loading={transitioning}
        disabled={isDisabled}
        aria-pressed={isPaused}
        aria-label={
          isPaused
            ? "Go ready — currently paused"
            : "Pause — currently ready"
        }
        aria-busy={transitioning}
        onClick={() => {
          if (isPaused) {
            void handleUnpause();
          } else {
            void handlePauseClick();
          }
        }}
      >
        {buttonLabel}
      </Button>

      {/* Code picker — only shown in OPTIONAL/FORCE mode */}
      {pauseConfig.pauseCodesRequired !== "OFF" && (
        <PauseCodeMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          mode={pauseConfig.pauseCodesRequired}
          codes={pauseConfig.codes}
          loading={pauseConfig.loading}
          error={pauseConfig.error}
          lastUsedCode={lastUsedPauseCode}
          onSelect={handleMenuSelect}
          onCancel={handleMenuCancel}
        />
      )}
    </>
  );
}
