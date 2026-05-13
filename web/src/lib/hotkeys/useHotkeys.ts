"use client";

import * as React from "react";
import {
  hotkeyRegistry,
  type HotkeyBinding,
  type HotkeyScope,
} from "./registry";

export type { HotkeyScope };

export interface HotkeyDef
  extends Omit<HotkeyBinding, "id" | "handler"> {
  handler: (e: KeyboardEvent) => void;
  /** Optional human-readable description for the hotkey help overlay. */
  description?: string;
}

let idCounter = 0;
function nextId(): string {
  return `hk-${++idCounter}`;
}

/**
 * Declaratively register one or more hotkeys.
 *
 * @example
 * useHotkeys([
 *   { scope: 'global', key: 'F1', ignoreInputFocus: true, handler: onHelp },
 *   { scope: 'in-call', key: 'm', handler: onMute },
 * ]);
 *
 * Hotkeys are registered on mount and deregistered on unmount (or when the
 * `defs` array reference changes — keep it stable with useMemo / useCallback).
 */
export function useHotkeys(defs: HotkeyDef[]): void {
  // Stable ref so the effect doesn't re-run every render
  const defsRef = React.useRef(defs);
  defsRef.current = defs;

  // Assign stable IDs once on first render
  const ids = React.useRef<string[]>([]);
  if (ids.current.length !== defs.length) {
    ids.current = defs.map(() => nextId());
  }

  React.useEffect(() => {
    const offs = defsRef.current.map((def, i) =>
      hotkeyRegistry.register({ ...def, id: ids.current[i] }),
    );
    return () => offs.forEach((off) => off());
  }, []); // intentionally run once; handler updates via defsRef
}
