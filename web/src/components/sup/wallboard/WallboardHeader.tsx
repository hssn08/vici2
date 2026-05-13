"use client";

// WallboardHeader — clock, board title, fullscreen toggle.
// Stays fixed at the top of the wallboard; minimal chrome.
//
// S04 PLAN §3.1.

import React, { useState, useEffect } from "react";
import { BOARD_LABELS } from "@/lib/stores/wallboard.js";
import type { BoardId } from "@/lib/stores/wallboard.js";

export interface WallboardHeaderProps {
  currentBoard: BoardId | string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

function useClock(): string {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  useEffect(() => {
    const id = setInterval(() => {
      setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

export function WallboardHeader({
  currentBoard,
  fullscreen,
  onToggleFullscreen,
}: WallboardHeaderProps): React.ReactElement {
  const clock = useClock();
  const label = BOARD_LABELS[currentBoard as BoardId] ?? currentBoard;

  return (
    <header
      className="wallboard-header"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.4em 1em",
        background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(4px)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0,
        gap: "1em",
      }}
    >
      {/* Board title */}
      <h1
        style={{
          fontSize: "1.1em",
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "#94a3b8",
          margin: 0,
        }}
      >
        {label}
      </h1>

      {/* Clock + fullscreen */}
      <div style={{ display: "flex", alignItems: "center", gap: "1em" }}>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: "1em",
            fontVariantNumeric: "tabular-nums",
            color: "#cbd5e1",
          }}
          aria-label="Current time"
        >
          {clock}
        </span>

        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen (F)"}
          title={fullscreen ? "Exit fullscreen" : "Enter fullscreen (F)"}
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "0.3em",
            color: "#94a3b8",
            cursor: "pointer",
            padding: "0.2em 0.5em",
            fontSize: "0.8em",
            lineHeight: 1.5,
          }}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
      </div>
    </header>
  );
}
