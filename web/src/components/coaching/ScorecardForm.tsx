"use client";

/**
 * ScorecardForm — template-driven scorecard form with live total computation.
 * S05 PLAN §5
 */

import * as React from "react";
import { useMemo } from "react";
import { CriterionInput } from "./CriterionInput";
import { ScoreDisplay } from "./ScoreDisplay";
import type { ScorecardCriterion, ScoreEntry, ScorecardTemplate, CallScorecard } from "./types";

function computeTotal(criteria: ScorecardCriterion[], scores: ScoreEntry[]): number {
  const autoFailCriteria = criteria.filter((c) => c.auto_fail);
  for (const c of autoFailCriteria) {
    const entry = scores.find((s) => s.criterion_id === c.id);
    if (entry && entry.score === 0 && !entry.na) return 0.0;
  }

  const scoringCriteria = criteria.filter((c) => c.type !== "text_only" && !c.auto_fail);
  const naIds = new Set(scores.filter((s) => s.na).map((s) => s.criterion_id));

  const activeWeight = scoringCriteria
    .filter((c) => !naIds.has(c.id))
    .reduce((acc, c) => acc + c.weight, 0);

  if (activeWeight === 0) return 0.0;

  let total = 0;
  for (const c of scoringCriteria) {
    if (naIds.has(c.id)) continue;
    const entry = scores.find((s) => s.criterion_id === c.id);
    const score = entry?.score ?? 0;
    const normalizedWeight = (c.weight / activeWeight) * 100;
    total += (score / c.max_score) * normalizedWeight;
  }

  return Math.round(total * 100) / 100;
}

interface ScorecardFormProps {
  template: ScorecardTemplate;
  scorecard?: CallScorecard | null;
  onSave?: (scores: ScoreEntry[], comments: string) => Promise<void>;
  onFinalize?: (scores: ScoreEntry[], comments: string) => Promise<void>;
  readOnly?: boolean;
  isSaving?: boolean;
  isFinalizing?: boolean;
}

export function ScorecardForm({
  template,
  scorecard,
  onSave,
  onFinalize,
  readOnly = false,
  isSaving = false,
  isFinalizing = false,
}: ScorecardFormProps): React.ReactElement {
  const [scores, setScores] = React.useState<ScoreEntry[]>(
    () => (scorecard?.scores as ScoreEntry[]) ?? [],
  );
  const [comments, setComments] = React.useState(scorecard?.comments ?? "");

  const criteria = template.criteria;
  const totalScore = useMemo(() => computeTotal(criteria, scores), [criteria, scores]);

  // Group by section
  const sections = useMemo(() => {
    const map = new Map<string, ScorecardCriterion[]>();
    for (const c of criteria) {
      const section = c.section ?? "General";
      if (!map.has(section)) map.set(section, []);
      map.get(section)!.push(c);
    }
    return map;
  }, [criteria]);

  function handleCriterionChange(entry: ScoreEntry): void {
    setScores((prev) => {
      const idx = prev.findIndex((s) => s.criterion_id === entry.criterion_id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }

  async function handleSave(): Promise<void> {
    await onSave?.(scores, comments);
  }

  async function handleFinalize(): Promise<void> {
    await onFinalize?.(scores, comments);
  }

  const isFinalized = scorecard?.status === "finalized";

  return (
    <div className="flex flex-col gap-6" role="form" aria-label="Scorecard evaluation form">
      {/* Template header */}
      <div className="border-b border-gray-200 pb-4">
        <p className="text-xs text-gray-500 uppercase tracking-wide">Template</p>
        <p className="font-semibold text-gray-900">
          {template.name}
          <span className="ml-2 text-xs text-gray-400">v{template.version}</span>
        </p>
        {template.description && (
          <p className="mt-1 text-xs text-gray-500">{template.description}</p>
        )}
      </div>

      {/* Criteria by section */}
      {Array.from(sections.entries()).map(([section, sectionCriteria]) => (
        <div key={section} className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {section}
          </h3>
          <div className="flex flex-col gap-4 pl-1">
            {sectionCriteria.map((c) => (
              <CriterionInput
                key={c.id}
                criterion={c}
                entry={scores.find((s) => s.criterion_id === c.id)}
                onChange={handleCriterionChange}
                readOnly={readOnly || isFinalized}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Total score */}
      <div className="flex items-center justify-between border-t border-gray-200 pt-4">
        <span className="text-sm font-semibold text-gray-700">Total Score</span>
        <ScoreDisplay score={totalScore} />
      </div>

      {/* Overall comment */}
      {!readOnly && !isFinalized && (
        <div className="flex flex-col gap-1">
          <label htmlFor="overall-comment" className="text-xs font-medium text-gray-600">
            Overall Comment
          </label>
          <textarea
            id="overall-comment"
            rows={3}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Optional overall evaluation note..."
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      )}

      {readOnly && scorecard?.comments && (
        <div className="rounded bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-500 mb-1">Overall Comment</p>
          <p className="text-sm text-gray-700">{scorecard.comments}</p>
        </div>
      )}

      {/* Actions */}
      {!readOnly && !isFinalized && (
        <div className="flex gap-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isFinalizing}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {isSaving ? "Saving…" : "Save Draft"}
          </button>
          <button
            type="button"
            onClick={handleFinalize}
            disabled={isSaving || isFinalizing}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {isFinalizing ? "Finalizing…" : "Finalize"}
          </button>
        </div>
      )}

      {isFinalized && (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          This scorecard has been finalized and is now locked.
        </div>
      )}
    </div>
  );
}
