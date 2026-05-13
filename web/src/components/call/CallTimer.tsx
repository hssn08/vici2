"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CallTimer({ className }: { className?: string }): React.ReactElement {
  const startedAt = useCallStore((s) => s.startedAt);
  const phase = useCallStore((s) => s.phase);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!startedAt || phase === "idle" || phase === "ringing") {
      setElapsed(0);
      return;
    }

    // Use requestAnimationFrame when in foreground, setInterval when backgrounded
    let rafId: number | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      setElapsed(Date.now() - startedAt);
    };

    const startRaf = () => {
      const loop = () => {
        tick();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    };

    const startInterval = () => {
      tick();
      intervalId = setInterval(tick, 1000);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        startInterval();
      } else {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        startRaf();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    if (document.hidden) {
      startInterval();
    } else {
      startRaf();
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [startedAt, phase]);

  const display = formatDuration(elapsed);
  const isoSeconds = Math.floor(elapsed / 1000);

  return (
    <time
      dateTime={`PT${isoSeconds}S`}
      aria-label={`Call duration: ${display}`}
      className={className}
    >
      {display}
    </time>
  );
}
