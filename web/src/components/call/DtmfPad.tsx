"use client";

import * as React from "react";
import { useSoftphone } from "@/lib/sip";
import { cn } from "@/lib/utils";

const DTMF_KEYS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
] as const;

type DtmfTone = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#";

const VALID_DTMF = new Set<string>(["0","1","2","3","4","5","6","7","8","9","*","#"]);

const RATE_LIMIT_MS = 100; // 10/s max

interface DtmfPadProps {
  onClose: () => void;
}

export function DtmfPad({ onClose }: DtmfPadProps): React.ReactElement {
  const { sendDtmf } = useSoftphone();
  const [echo, setEcho] = React.useState<string[]>([]);
  const lastSentRef = React.useRef<number>(0);
  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const sendTone = React.useCallback(
    (tone: string, duration = 200) => {
      const now = Date.now();
      if (now - lastSentRef.current < RATE_LIMIT_MS) return;
      lastSentRef.current = now;
      sendDtmf(tone as DtmfTone);
      setEcho((prev) => [...prev.slice(-11), tone]);
      void duration; // used by hold logic
    },
    [sendDtmf],
  );

  const sendSequence = React.useCallback(
    async (tones: string[]) => {
      for (const t of tones.slice(0, 32)) {
        sendTone(t);
        await new Promise((r) => setTimeout(r, 80));
      }
    },
    [sendTone],
  );

  // Clear echo after 5s idle
  React.useEffect(() => {
    if (echo.length === 0) return;
    const id = setTimeout(() => setEcho([]), 5000);
    return () => clearTimeout(id);
  }, [echo]);

  const handleMouseDown = (tone: string) => {
    sendTone(tone, 200);
    holdTimerRef.current = setTimeout(() => sendTone(tone, 600), 300);
  };

  const handleMouseUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Backspace") { setEcho((prev) => prev.slice(0, -1)); return; }
    if (VALID_DTMF.has(e.key)) {
      e.preventDefault();
      sendTone(e.key);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const valid = text.split("").filter((c) => VALID_DTMF.has(c)).slice(0, 32);
    await sendSequence(valid);
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="DTMF keypad"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      className="absolute bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-4 shadow-xl outline-none"
    >
      {/* Echo display */}
      <div
        aria-live="polite"
        aria-label="Sent tones"
        className="mb-3 flex min-h-6 items-center justify-between rounded bg-[var(--color-surface-muted)] px-3 py-1"
      >
        <span className="font-mono text-sm tracking-widest">
          {echo.join(" ") || " "}
        </span>
        {echo.length > 0 && (
          <button
            aria-label="Clear echo"
            onClick={() => setEcho([])}
            className="ml-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Clear
          </button>
        )}
      </div>

      {/* 4×3 grid */}
      <div role="grid" aria-label="DTMF keys" className="grid grid-cols-3 gap-2">
        {DTMF_KEYS.flat().map((tone) => (
          <button
            key={tone}
            role="gridcell"
            aria-label={`Send tone ${tone}`}
            onMouseDown={() => handleMouseDown(tone)}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              "flex h-16 w-16 items-center justify-center rounded-lg border border-[var(--color-surface-border)] text-xl font-semibold",
              "hover:bg-[var(--color-surface-muted)] active:bg-[var(--color-brand-600)] active:text-white transition-colors",
            )}
          >
            {tone}
          </button>
        ))}
      </div>

      <button
        onClick={onClose}
        className="mt-3 w-full rounded border border-[var(--color-surface-border)] py-1.5 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
      >
        Close (Esc)
      </button>
    </div>
  );
}
