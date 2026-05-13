"use client";

import * as React from "react";
import { TopBar } from "@/components/call/TopBar";
import { LeftPanel } from "@/components/call/LeftPanel";
import { CenterPanel } from "@/components/call/CenterPanel";
import { ActionBar } from "@/components/call/ActionBar";
import { cn } from "@/lib/utils";

/**
 * Top-level grid layout per A05 PLAN §2.1 (FROZEN):
 *   grid-template-columns: 360px 1fr
 *   grid-template-rows: 56px 1fr 64px
 *   height: 100dvh; overflow: hidden
 */
export function CallPanelRoot({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      aria-label="Call panel"
      className={cn("call-panel-root", className)}
      style={{
        display: "grid",
        gridTemplateColumns: "360px 1fr",
        gridTemplateRows: "56px 1fr 64px",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      {/* Row 1: Top bar (sticky, spans full width) */}
      <TopBar />

      {/* Row 2, Col 1: Left panel */}
      <div
        className="hidden md:contents"
        style={{ display: "contents" }}
      >
        <LeftPanel className="[grid-column:1] [grid-row:2]" />
      </div>

      {/* Row 2, Col 2: Center panel with tabs + disposition overlay */}
      <CenterPanel className="[grid-column:2_/_-1] [grid-row:2]" />

      {/* Row 3: Action bar (sticky bottom, spans full width) */}
      <ActionBar />
    </div>
  );
}
