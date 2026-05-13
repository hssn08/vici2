"use client";

// useFullscreen — Fullscreen API wrapper for the TV wallboard.
//
// Toggle via `toggle()` or the F key shortcut.
// Gracefully degrades: if Fullscreen API is unavailable returns { supported: false }.
//
// S04 PLAN §3.1.

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseFullscreenReturn {
  /** Ref to attach to the element that should go fullscreen. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** true if currently in fullscreen mode. */
  fullscreen: boolean;
  /** true if the browser supports the Fullscreen API. */
  supported: boolean;
  /** Enter or exit fullscreen. */
  toggle: () => Promise<void>;
}

export function useFullscreen(): UseFullscreenReturn {
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const supported =
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function";

  const toggle = useCallback(async () => {
    if (!supported) return;
    if (!document.fullscreenElement) {
      try {
        await (ref.current ?? document.documentElement).requestFullscreen();
      } catch {
        // User denied or browser blocked (e.g., not from a user gesture).
      }
    } else {
      try {
        await document.exitFullscreen();
      } catch {
        // Already exited.
      }
    }
  }, [supported]);

  // Sync fullscreen state from DOM events (e.g., user presses Esc).
  useEffect(() => {
    function handleChange(): void {
      setFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
    };
  }, []);

  // 'F' key shortcut to toggle fullscreen.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // Only when not in an input/textarea.
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "f" || e.key === "F") {
        void toggle();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggle]);

  return { ref, fullscreen, supported, toggle };
}
