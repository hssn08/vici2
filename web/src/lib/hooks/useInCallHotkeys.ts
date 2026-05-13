"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";

type HotkeyHandler = () => void;

interface HotkeyDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** If true, fires even when an input/textarea is focused */
  ignoreInputFocus?: boolean;
  handler: HotkeyHandler;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (el as HTMLElement).isContentEditable
  );
}

/**
 * Register in-call hotkeys.
 * Returns a keydown handler to attach to the document.
 */
export function useInCallHotkeys(handlers: {
  onHangup: HotkeyHandler;
  onHold: HotkeyHandler;
  onMute: HotkeyHandler;
  onDtmf: HotkeyHandler;
  onTransfer: HotkeyHandler;
  onThreeWay: HotkeyHandler;
  onRecord?: HotkeyHandler;
  onCallback: HotkeyHandler;
  onDnc: HotkeyHandler;
  onDispoHotkey: (digit: string) => void;
  onHelp: HotkeyHandler;
  onEsc: HotkeyHandler;
}): void {
  const phase = useCallStore((s) => s.phase);
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    const hotkeys: HotkeyDef[] = [
      // F-keys always fire
      { key: "F1", ignoreInputFocus: true, handler: () => handlersRef.current.onHelp() },
      { key: "F2", ignoreInputFocus: true, handler: () => handlersRef.current.onHold() },
      { key: "F3", ignoreInputFocus: true, handler: () => handlersRef.current.onHangup() },
      { key: "F4", ignoreInputFocus: true, handler: () => handlersRef.current.onMute() },
      // Single-letter — suppressed in inputs
      { key: " ", handler: () => handlersRef.current.onHold() },
      { key: "m", handler: () => handlersRef.current.onMute() },
      { key: "M", handler: () => handlersRef.current.onMute() },
      { key: "d", handler: () => handlersRef.current.onDtmf() },
      { key: "D", handler: () => handlersRef.current.onDtmf() },
      { key: "r", handler: () => { if (handlersRef.current.onRecord) handlersRef.current.onRecord(); } },
      { key: "R", handler: () => { if (handlersRef.current.onRecord) handlersRef.current.onRecord(); } },
      { key: "?", handler: () => handlersRef.current.onHelp() },
      // Ctrl+key — always fire
      { key: "t", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onTransfer() },
      { key: "T", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onTransfer() },
      { key: "3", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onThreeWay() },
      { key: "b", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onCallback() },
      { key: "B", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onCallback() },
      { key: "d", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onDnc() },
      { key: "D", ctrl: true, ignoreInputFocus: true, handler: () => handlersRef.current.onDnc() },
      // Escape — always fires
      { key: "Escape", ignoreInputFocus: true, handler: () => handlersRef.current.onEsc() },
      // Dispo digit hotkeys — only in wrapup, suppressed in inputs
      ...["0","1","2","3","4","5","6","7","8","9"].map((d) => ({
        key: d,
        handler: () => {
          if (phase === "wrapup") handlersRef.current.onDispoHotkey(d);
        },
      })),
    ];

    const onKeyDown = (e: KeyboardEvent) => {
      const inputFocused = isInputFocused();

      for (const hk of hotkeys) {
        if (hk.key !== e.key) continue;
        if (hk.ctrl !== undefined && hk.ctrl !== e.ctrlKey) continue;
        if (hk.shift !== undefined && hk.shift !== e.shiftKey) continue;
        if (hk.alt !== undefined && hk.alt !== e.altKey) continue;

        // Suppress single-key (no modifier) if input focused, unless ignoreInputFocus
        if (
          inputFocused &&
          !hk.ignoreInputFocus &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey
        ) {
          continue;
        }

        e.preventDefault();
        hk.handler();
        break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [phase]); // re-register on phase change for dispo scope
}
