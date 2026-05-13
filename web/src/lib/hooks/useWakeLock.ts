"use client";

// useWakeLock — requests a screen wake lock on mount so TV displays don't sleep.
//
// Gracefully degrades: if Wake Lock API is unavailable (e.g., Firefox without flag,
// HTTP context) the hook is a no-op and returns { supported: false }.
//
// Re-acquires the lock on visibility change (page re-focus after the display slept).
//
// S04 PLAN §3.1.

import { useEffect, useRef, useState } from "react";

export interface UseWakeLockReturn {
  /** true if the browser supports navigator.wakeLock */
  supported: boolean;
  /** true if a lock is currently held */
  active: boolean;
  /** Manually release the lock (e.g., on component unmount). */
  release: () => Promise<void>;
}

export function useWakeLock(): UseWakeLockReturn {
  const supported =
    typeof navigator !== "undefined" &&
    "wakeLock" in navigator &&
    typeof (navigator as Navigator & { wakeLock?: unknown }).wakeLock !== "undefined";

  const lockRef = useRef<WakeLockSentinel | null>(null);
  const [active, setActive] = useState(false);

  async function acquire(): Promise<void> {
    if (!supported) return;
    try {
      lockRef.current = await (
        navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }
      ).wakeLock.request("screen");
      setActive(true);
      lockRef.current.addEventListener("release", () => {
        setActive(false);
      });
    } catch {
      // Permission denied or unavailable (e.g., battery saver mode).
      setActive(false);
    }
  }

  async function release(): Promise<void> {
    if (lockRef.current) {
      try {
        await lockRef.current.release();
      } catch {
        // Already released.
      }
      lockRef.current = null;
      setActive(false);
    }
  }

  useEffect(() => {
    void acquire();

    // Re-acquire after the tab becomes visible again.
    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible" && !lockRef.current) {
        void acquire();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void release();
    };
  }, []); // Mount-only: acquire on mount, release on unmount

  return { supported, active, release };
}
