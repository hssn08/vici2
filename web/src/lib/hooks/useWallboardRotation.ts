"use client";

// useWallboardRotation — cycles through an array of board IDs on a fixed interval.
//
// Pauses when `paused` is true (e.g., mouse hover).
// Returns: current board ID, index, and total count.
//
// S04 PLAN §3.2.

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseWallboardRotationReturn {
  /** Currently displayed board ID. */
  currentBoard: string;
  /** 0-based index of the current board. */
  currentIndex: number;
  /** Total number of boards. */
  total: number;
  /** Progress ratio for the current interval (0–1). */
  progress: number;
  /** Manually jump to a specific board index. */
  goTo: (index: number) => void;
  /** Pause or resume auto-rotation. */
  setPaused: (paused: boolean) => void;
}

export function useWallboardRotation(
  boards: string[],
  rotateMs: number,
): UseWallboardRotationReturn {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const total = boards.length;

  // Safety guard: clamp currentIndex when boards array shrinks.
  const safeIndex = total > 0 ? Math.min(currentIndex, total - 1) : 0;
  const currentBoard = total > 0 ? (boards[safeIndex] ?? boards[0] ?? "") : "";

  const goTo = useCallback(
    (index: number): void => {
      setCurrentIndex(Math.max(0, Math.min(index, total - 1)));
      setProgress(0);
    },
    [total],
  );

  useEffect(() => {
    if (total <= 1) return;

    let startTime = performance.now();
    let raf: number;

    function tick(now: number): void {
      if (!pausedRef.current) {
        const elapsed = now - startTime;
        const ratio = Math.min(elapsed / rotateMs, 1);
        setProgress(ratio);

        if (ratio >= 1) {
          setCurrentIndex((prev) => (prev + 1) % total);
          startTime = now;
        }
      } else {
        // While paused, reset the start time so resumption feels natural.
        startTime = now;
      }
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [total, rotateMs]);

  return {
    currentBoard,
    currentIndex: safeIndex,
    total,
    progress,
    goTo,
    setPaused,
  };
}
