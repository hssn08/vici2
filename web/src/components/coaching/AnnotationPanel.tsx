"use client";

/**
 * AnnotationPanel — scrollable list of annotations with seek-on-click.
 * S05 PLAN §4.2
 */

import * as React from "react";
import type { Annotation, AnnotationTag } from "./types";
import { TAG_COLORS, TAG_LABELS } from "./types";

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface AnnotationPanelProps {
  annotations: Annotation[];
  activeId?: string | null;
  onSeek?: (timestampMs: number) => void;
  onEdit?: (annotation: Annotation) => void;
  onDelete?: (annotationId: string) => void;
  readOnly?: boolean;
  isLocked?: boolean;
}

export function AnnotationPanel({
  annotations,
  activeId,
  onSeek,
  onEdit,
  onDelete,
  readOnly = false,
  isLocked = false,
}: AnnotationPanelProps): React.ReactElement {
  const sorted = [...annotations].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  return (
    <div className="flex flex-col gap-2" role="list" aria-label="Call annotations">
      {sorted.length === 0 && (
        <p className="text-xs text-gray-400 italic text-center py-4">
          No annotations yet. Press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-xs">A</kbd> or click &quot;Add Annotation&quot; to add one.
        </p>
      )}

      {sorted.map((ann) => {
        const color = TAG_COLORS[ann.tag as AnnotationTag] ?? "#888";
        const isActive = activeId === ann.id;

        return (
          <div
            key={ann.id}
            role="listitem"
            className={`group rounded-md border p-3 cursor-pointer transition-colors ${
              isActive
                ? "border-blue-400 bg-blue-50"
                : "border-gray-200 bg-white hover:border-gray-300"
            }`}
            onClick={() => onSeek?.(ann.timestamp_ms)}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSeek?.(ann.timestamp_ms); }}
            aria-label={`Annotation at ${formatTimestamp(ann.timestamp_ms)}: ${ann.text}`}
          >
            <div className="flex items-start gap-2">
              {/* Colored dot */}
              <span
                className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-500">
                    {formatTimestamp(ann.timestamp_ms)}
                  </span>
                  <span
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${color}22`, color }}
                  >
                    {TAG_LABELS[ann.tag as AnnotationTag] ?? ann.tag}
                  </span>
                </div>

                <p className="text-xs text-gray-800 line-clamp-2">{ann.text}</p>

                {ann.supervisor?.full_name && (
                  <p className="mt-1 text-[10px] text-gray-400">
                    by {ann.supervisor.full_name}
                  </p>
                )}
              </div>

              {/* Edit / Delete actions */}
              {!readOnly && !isLocked && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {onEdit && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onEdit(ann); }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50"
                      aria-label={`Edit annotation at ${formatTimestamp(ann.timestamp_ms)}`}
                    >
                      Edit
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onDelete(ann.id); }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50"
                      aria-label={`Delete annotation at ${formatTimestamp(ann.timestamp_ms)}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
