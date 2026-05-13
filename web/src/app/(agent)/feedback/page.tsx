// S05 — Agent feedback inbox page.
// S05 PLAN §6.1

"use client";

import * as React from "react";
import { useState, useEffect } from "react";
import { FeedbackCard } from "@/components/coaching/FeedbackCard";
import type { AgentFeedback } from "@/components/coaching/types";
import { env } from "@/lib/env";

export default function FeedbackInboxPage(): React.ReactElement {
  const [feedback, setFeedback] = useState<AgentFeedback[]>([]);
  const [activeTab, setActiveTab] = useState<"feedback" | "scorecards">("feedback");
  const [isLoading, setIsLoading] = useState(true);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void loadFeedback();
  }, []);

  async function loadFeedback(): Promise<void> {
    setIsLoading(true);
    try {
      const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/agent/feedback`, {
        credentials: "include",
      });
      if (res.ok) {
        const json = await res.json() as { feedback: AgentFeedback[] };
        setFeedback(json.feedback);
      }
    } finally {
      setIsLoading(false);
    }
  }

  function showToast(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleAcknowledge(id: string): Promise<void> {
    setAcknowledgingId(id);
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/agent/feedback/${id}/acknowledge`,
        { method: "PATCH", credentials: "include" },
      );
      if (res.ok) {
        setFeedback((prev) =>
          prev.map((f) =>
            f.id === id ? { ...f, acknowledged_at: new Date().toISOString() } : f,
          ),
        );
        showToast("Feedback acknowledged");
      } else {
        showToast("Failed to acknowledge");
      }
    } finally {
      setAcknowledgingId(null);
    }
  }

  const unreadCount = feedback.filter((f) => !f.acknowledged_at).length;

  return (
    <main className="min-h-screen bg-gray-50">
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-4 right-4 z-50 rounded-md bg-gray-900 text-white px-4 py-2 text-sm shadow-lg"
        >
          {toast}
        </div>
      )}

      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">My Feedback Inbox</h1>
            {unreadCount > 0 && (
              <p className="mt-1 text-sm text-amber-600 font-medium">{unreadCount} unread</p>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-4" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "feedback"}
            onClick={() => setActiveTab("feedback")}
            className={`py-3 px-4 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "feedback"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Feedback Notes ({feedback.length})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "scorecards"}
            onClick={() => setActiveTab("scorecards")}
            className={`py-3 px-4 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "scorecards"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Scorecards
          </button>
        </div>

        {/* Content */}
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-sm text-gray-400">
            Loading feedback…
          </div>
        )}

        {!isLoading && activeTab === "feedback" && (
          <div className="flex flex-col gap-3" role="list" aria-label="Feedback messages">
            {feedback.length === 0 && (
              <p className="text-center py-8 text-sm text-gray-400">No feedback yet.</p>
            )}
            {feedback.map((f) => (
              <FeedbackCard
                key={f.id}
                feedback={f}
                onAcknowledge={handleAcknowledge}
                isAcknowledging={acknowledgingId === f.id}
              />
            ))}
          </div>
        )}

        {!isLoading && activeTab === "scorecards" && (
          <ScorecardsTab />
        )}
      </div>
    </main>
  );
}

function ScorecardsTab(): React.ReactElement {
  const [scorecards, setScorecards] = React.useState<unknown[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/agent/scorecards`, {
          credentials: "include",
        });
        if (res.ok) {
          const json = await res.json() as { scorecards: unknown[] };
          setScorecards(json.scorecards);
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-gray-400">
        Loading scorecards…
      </div>
    );
  }

  if (scorecards.length === 0) {
    return <p className="text-center py-8 text-sm text-gray-400">No scorecards yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-3" aria-label="My scorecards">
      {(scorecards as Array<{ id: string; totalScore: string; createdAt: string; template?: { name: string } }>).map((sc) => (
        <li key={sc.id}>
          <a
            href={`/feedback/scorecards/${sc.id}`}
            className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-blue-300 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {sc.template?.name ?? "Scorecard"}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {new Date(sc.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-blue-800">
                {Number(sc.totalScore).toFixed(1)} / 100
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
