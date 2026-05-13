"use client";

import * as React from "react";
import { LeadInfoCard } from "@/components/call/LeadInfoCard";
import { HistoryTimeline } from "@/components/call/HistoryTimeline";
import { NotesPanel } from "@/components/call/NotesPanel";
import { cn } from "@/lib/utils";

export function LeftPanel({ className }: { className?: string }): React.ReactElement {
  return (
    <aside
      aria-label="Lead info and notes"
      className={cn(
        "call-left-panel overflow-y-auto border-r border-[var(--color-surface-border)] bg-[var(--color-surface)]",
        className,
      )}
      style={{ gridColumn: 1, gridRow: 2 }}
    >
      <LeadInfoCard />
      <hr className="border-[var(--color-surface-border)]" />
      <HistoryTimeline />
      <hr className="border-[var(--color-surface-border)]" />
      <NotesPanel />
    </aside>
  );
}
