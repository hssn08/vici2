"use client";

/**
 * ScoreDisplay — total score badge with color coding.
 * ≥90: green, 75-89: blue, 60-74: amber, <60: red
 * S05 PLAN §5.3
 */

import * as React from "react";
import { Badge } from "@/components/ui/badge";

interface ScoreDisplayProps {
  score: number | null;
  className?: string;
}

function getScoreColor(score: number | null): { bg: string; text: string } {
  if (score === null) return { bg: "bg-gray-100", text: "text-gray-500" };
  if (score >= 90) return { bg: "bg-green-100", text: "text-green-800" };
  if (score >= 75) return { bg: "bg-blue-100", text: "text-blue-800" };
  if (score >= 60) return { bg: "bg-amber-100", text: "text-amber-800" };
  return { bg: "bg-red-100", text: "text-red-800" };
}

export function ScoreDisplay({ score, className = "" }: ScoreDisplayProps): React.ReactElement {
  const { bg, text } = getScoreColor(score);
  const displayScore = score !== null ? `${score.toFixed(1)} / 100` : "—";

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${bg} ${text} ${className}`}
      aria-label={`Score: ${displayScore}`}
    >
      {displayScore}
    </span>
  );
}
