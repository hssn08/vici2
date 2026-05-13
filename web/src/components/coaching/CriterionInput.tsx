"use client";

/**
 * CriterionInput — per-criterion input by type (numeric/binary/auto_fail/text_only)
 * S05 PLAN §5.2
 */

import * as React from "react";
import type { ScorecardCriterion, ScoreEntry } from "./types";

interface CriterionInputProps {
  criterion: ScorecardCriterion;
  entry: ScoreEntry | undefined;
  onChange: (entry: ScoreEntry) => void;
  readOnly?: boolean;
}

export function CriterionInput({
  criterion,
  entry,
  onChange,
  readOnly = false,
}: CriterionInputProps): React.ReactElement {
  const isNa = entry?.na ?? false;
  const score = entry?.score ?? 0;
  const comment = entry?.comment ?? "";

  function handleScoreChange(newScore: number): void {
    onChange({ criterion_id: criterion.id, score: newScore, na: isNa, comment });
  }

  function handleNaChange(checked: boolean): void {
    onChange({ criterion_id: criterion.id, score: score, na: checked, comment });
  }

  function handleCommentChange(newComment: string): void {
    onChange({ criterion_id: criterion.id, score: score, na: isNa, comment: newComment });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-gray-900 flex-1">{criterion.label}</span>

        <div className="flex items-center gap-3 shrink-0">
          {/* N/A toggle */}
          {criterion.na_eligible && !readOnly && (
            <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={isNa}
                onChange={(e) => handleNaChange(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300"
                aria-label={`Mark ${criterion.label} as N/A`}
              />
              N/A
            </label>
          )}

          {/* Score input by type */}
          {criterion.type === "text_only" && (
            <span className="text-xs text-gray-400 italic">Text only</span>
          )}

          {criterion.type === "numeric" && !isNa && (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={criterion.max_score}
                step={1}
                value={score}
                disabled={readOnly}
                onChange={(e) => handleScoreChange(Number(e.target.value))}
                className="w-24 accent-blue-600"
                aria-label={`${criterion.label} score`}
              />
              <span className="w-12 text-right text-sm font-mono text-gray-700">
                {score}/{criterion.max_score}
              </span>
            </div>
          )}

          {criterion.type === "binary" && !isNa && (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => handleScoreChange(score === criterion.max_score ? 0 : criterion.max_score)}
              className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
                score === criterion.max_score
                  ? "bg-green-100 text-green-800 hover:bg-green-200"
                  : "bg-red-100 text-red-800 hover:bg-red-200"
              } ${readOnly ? "cursor-default" : "cursor-pointer"}`}
              aria-label={`${criterion.label}: ${score === criterion.max_score ? "Yes" : "No"}`}
            >
              {score === criterion.max_score ? "Yes" : "No"}
            </button>
          )}

          {criterion.type === "auto_fail" && !isNa && (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => handleScoreChange(score === 1 ? 0 : 1)}
              className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
                score === 1
                  ? "bg-green-100 text-green-800 hover:bg-green-200"
                  : "bg-red-100 text-red-800 hover:bg-red-200"
              } ${readOnly ? "cursor-default" : "cursor-pointer"}`}
              aria-label={`${criterion.label}: ${score === 1 ? "Pass" : "FAIL"}`}
            >
              {score === 1 ? "Pass" : "FAIL"}
            </button>
          )}

          {isNa && (
            <span className="text-xs text-gray-400 italic w-16 text-right">N/A</span>
          )}
        </div>
      </div>

      {/* Per-criterion comment */}
      {criterion.type !== "text_only" && !readOnly && (
        <input
          type="text"
          placeholder="Add comment (optional)"
          value={comment}
          onChange={(e) => handleCommentChange(e.target.value)}
          className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          aria-label={`Comment for ${criterion.label}`}
        />
      )}

      {criterion.type === "text_only" && !readOnly && (
        <textarea
          placeholder="Notes"
          value={comment}
          onChange={(e) => handleCommentChange(e.target.value)}
          rows={2}
          className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
          aria-label={`Notes for ${criterion.label}`}
        />
      )}

      {readOnly && comment && (
        <p className="text-xs text-gray-500 italic pl-1">{comment}</p>
      )}
    </div>
  );
}
