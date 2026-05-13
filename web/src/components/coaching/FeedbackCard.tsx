"use client";

/**
 * FeedbackCard — agent feedback inbox card with acknowledge button.
 * S05 PLAN §6.1
 */

import * as React from "react";
import type { AgentFeedback } from "./types";

interface FeedbackCardProps {
  feedback: AgentFeedback;
  onAcknowledge?: (id: string) => Promise<void>;
  isAcknowledging?: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function FeedbackCard({
  feedback,
  onAcknowledge,
  isAcknowledging = false,
}: FeedbackCardProps): React.ReactElement {
  const isAcknowledged = feedback.acknowledged_at !== null;

  return (
    <article
      className={`rounded-lg border p-4 transition-colors ${
        isAcknowledged ? "border-gray-200 bg-white" : "border-amber-200 bg-amber-50"
      }`}
      aria-label={`Feedback from ${feedback.supervisor?.full_name ?? "Supervisor"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          {!isAcknowledged && (
            <span
              className="h-2 w-2 rounded-full bg-amber-500 shrink-0 mt-1"
              aria-label="Unread"
            />
          )}
          {isAcknowledged && (
            <span
              className="h-2 w-2 rounded-full bg-green-500 shrink-0 mt-1"
              aria-label="Acknowledged"
            />
          )}
          <div>
            <p className="text-xs text-gray-500">
              {formatDate(feedback.created_at)}
              {feedback.supervisor?.full_name && (
                <span> — {feedback.supervisor.full_name}</span>
              )}
            </p>
          </div>
        </div>

        {!isAcknowledged && onAcknowledge && (
          <button
            type="button"
            onClick={() => onAcknowledge(feedback.id)}
            disabled={isAcknowledging}
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            aria-label="Acknowledge this feedback"
          >
            {isAcknowledging ? "Acknowledging…" : "Acknowledge"}
          </button>
        )}

        {isAcknowledged && (
          <span className="shrink-0 text-xs text-green-600 font-medium">
            Acknowledged {feedback.acknowledged_at ? formatDate(feedback.acknowledged_at) : ""}
          </span>
        )}
      </div>

      <p className="mt-3 text-sm text-gray-800 whitespace-pre-wrap">{feedback.body}</p>

      {feedback.related_call_uuid && (
        <div className="mt-2">
          <a
            href={`/sup/coaching/calls/${feedback.related_call_uuid}/review`}
            className="text-xs text-blue-600 hover:underline"
          >
            View Call Recording
          </a>
        </div>
      )}
    </article>
  );
}
