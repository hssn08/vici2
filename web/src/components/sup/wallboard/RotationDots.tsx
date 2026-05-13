"use client";

// RotationDots — progress indicator at the bottom of the wallboard.
// Shows one dot per board; the active dot has a fill-animation showing time left.
//
// S04 PLAN §3.2.

import React from "react";
import { BOARD_LABELS } from "@/lib/stores/wallboard.js";
import type { BoardId } from "@/lib/stores/wallboard.js";

export interface RotationDotsProps {
  boards: string[];
  currentIndex: number;
  progress: number; // 0–1
  onGoTo: (index: number) => void;
}

export function RotationDots({
  boards,
  currentIndex,
  progress,
  onGoTo,
}: RotationDotsProps): React.ReactElement {
  return (
    <nav
      aria-label="Wallboard board navigation"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.6em",
        padding: "0.5em 1em",
        flexShrink: 0,
        background: "rgba(0,0,0,0.4)",
        borderTop: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {boards.map((boardId, i) => {
        const isActive = i === currentIndex;
        const label = BOARD_LABELS[boardId as BoardId] ?? boardId;

        return (
          <button
            key={boardId}
            type="button"
            onClick={() => onGoTo(i)}
            aria-label={`Go to ${label}`}
            aria-current={isActive ? "true" : undefined}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0.2em",
              display: "flex",
              alignItems: "center",
              gap: "0.4em",
            }}
          >
            {/* Dot container */}
            <span
              style={{
                position: "relative",
                display: "inline-block",
                width: "0.8em",
                height: "0.8em",
                borderRadius: "50%",
                background: isActive ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)",
                overflow: "hidden",
              }}
            >
              {/* Progress fill for the active dot */}
              {isActive && (
                <span
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    width: "100%",
                    height: `${progress * 100}%`,
                    background: "#38bdf8",
                    transition: "height 0.1s linear",
                  }}
                />
              )}
            </span>

            {/* Board label (shown only when active or on hover) */}
            <span
              style={{
                fontSize: "0.55em",
                color: isActive ? "#e2e8f0" : "#64748b",
                fontWeight: isActive ? 600 : 400,
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
