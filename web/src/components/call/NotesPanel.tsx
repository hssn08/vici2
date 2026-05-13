"use client";

import * as React from "react";
import { useNotesSave } from "@/lib/hooks/useNotesSave";
import { cn } from "@/lib/utils";

const QUICK_TAGS = [
  { id: "callback", label: "[callback]" },
  { id: "interested", label: "[interested]" },
  { id: "not-interested", label: "[not-interested]" },
  { id: "wrong-person", label: "[wrong-person]" },
] as const;

const MAX_LENGTH = 4096;

export function NotesPanel({ className }: { className?: string }): React.ReactElement {
  const { notes, saveStatus, handleChange, handleBlur } = useNotesSave();
  const textareaId = "call-notes-textarea";
  const statusId = "call-notes-status";

  const toggleTag = (tag: string) => {
    if (notes.startsWith(tag + " ")) {
      handleChange(notes.slice(tag.length + 1));
    } else if (notes.includes(tag)) {
      handleChange(notes.replace(tag + " ", "").replace(tag, ""));
    } else {
      handleChange(tag + " " + notes);
    }
  };

  const statusLabel = {
    idle: "",
    saving: "Saving…",
    saved: "Saved ✓",
    error: "Save failed — retry?",
  }[saveStatus];

  const statusColor = {
    idle: "",
    saving: "text-[var(--color-fg-muted)]",
    saved: "text-[var(--color-state-active)]",
    error: "text-[var(--color-state-error)]",
  }[saveStatus];

  return (
    <div className={cn("px-4 pb-4", className)}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={textareaId} className="text-xs font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide">
          Notes (auto-save)
        </label>
        {statusLabel && (
          <span
            id={statusId}
            aria-live="polite"
            className={cn("text-xs", statusColor)}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {/* Quick-tag chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        {QUICK_TAGS.map((tag) => {
          const active = notes.includes(tag.label);
          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggleTag(tag.label)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                active
                  ? "border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-white"
                  : "border-[var(--color-surface-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-elevated)]",
              )}
            >
              {tag.label}
            </button>
          );
        })}
      </div>

      <textarea
        id={textareaId}
        aria-describedby={statusId}
        rows={6}
        maxLength={MAX_LENGTH}
        value={notes}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder="Type notes… Esc to return to hotkeys"
        className="w-full resize-none rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
        style={{ minHeight: "6rem", maxHeight: "12rem" }}
      />
      <div className="mt-0.5 flex justify-end">
        <span className="text-[10px] text-[var(--color-fg-muted)]">
          {notes.length}/{MAX_LENGTH}
        </span>
      </div>
    </div>
  );
}
