"use client";

import * as React from "react";
import { hotkeyRegistry } from "@/lib/hotkeys";

/**
 * HotkeyProvider
 *
 * Ensures the global hotkey registry listener is mounted exactly once at the
 * top of the component tree. The registry itself is a singleton, so this
 * provider is mainly an explicit signal that hotkeys are active.
 *
 * Individual feature components register their hotkeys via `useHotkeys()`.
 */
export function HotkeyProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  React.useEffect(() => {
    // The registry starts its listener lazily on first registration.
    // We just verify it's alive; nothing explicit needed.
    return () => {
      // On full unmount (e.g. test teardown) destroy the document listener.
      // In production this never runs since the provider lives for the app lifetime.
      hotkeyRegistry.destroy();
    };
  }, []);

  return <>{children}</>;
}
