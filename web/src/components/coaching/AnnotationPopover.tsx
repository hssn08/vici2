"use client";

/**
 * AnnotationPopover — modal for adding/editing an annotation.
 * S05 PLAN §4.1
 */

import * as React from "react";
import type { Annotation, AnnotationTag } from "./types";
import { TAG_LABELS } from "./types";

interface AnnotationPopoverProps {
  open: boolean;
  timestampMs: number;
  initial?: Annotation;
  onSubmit: (data: { text: string; tag: AnnotationTag }) => void;
  onClose: () => void;
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const ALL_TAGS = Object.keys(TAG_LABELS) as AnnotationTag[];

export function AnnotationPopover({
  open,
  timestampMs,
  initial,
  onSubmit,
  onClose,
}: AnnotationPopoverProps): React.ReactElement | null {
  const [text, setText] = React.useState(initial?.text ?? "");
  const [tag, setTag] = React.useState<AnnotationTag>(initial?.tag ?? "needs_improvement");

  React.useEffect(() => {
    if (open) {
      setText(initial?.text ?? "");
      setTag(initial?.tag ?? "needs_improvement");
    }
  }, [open, initial]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!text.trim()) return;
    onSubmit({ text: text.trim(), tag });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Add annotation"
    >
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          {initial ? "Edit Annotation" : "Add Annotation"}
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          At: <span className="font-mono">{formatTimestamp(timestampMs)}</span>
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="ann-text" className="text-xs font-medium text-gray-600">
              Note
            </label>
            <textarea
              id="ann-text"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Describe the coaching point..."
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              autoFocus
              required
            />
          </div>

          <div>
            <label htmlFor="ann-tag" className="text-xs font-medium text-gray-600">
              Tag
            </label>
            <select
              id="ann-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value as AnnotationTag)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {ALL_TAGS.map((t) => (
                <option key={t} value={t}>
                  {TAG_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {initial ? "Update" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
