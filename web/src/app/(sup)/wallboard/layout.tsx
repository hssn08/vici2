// S04 — Wallboard layout: chrome-free, full-viewport.
// Intentionally does NOT include nav, sidebar, or the (sup) shell.

import type { ReactNode } from "react";

export default function WallboardLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#0a0d14",
        color: "#f1f5f9",
      }}
    >
      {children}
    </div>
  );
}
