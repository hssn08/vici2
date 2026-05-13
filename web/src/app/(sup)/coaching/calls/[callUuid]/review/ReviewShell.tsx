"use client";

/**
 * ReviewShell — interactive client boundary for the review-call page.
 * Three-panel layout: annotation list | player | scorecard form.
 * S05 PLAN §3.1, §4
 */

import * as React from "react";
import { useState, useCallback } from "react";
import type { Annotation, CallScorecard, ScorecardTemplate, ScoreEntry, AnnotationTag } from "@/components/coaching/types";
import { AnnotationPanel } from "@/components/coaching/AnnotationPanel";
import { AnnotationPopover } from "@/components/coaching/AnnotationPopover";
import { ScorecardForm } from "@/components/coaching/ScorecardForm";
import { FeedbackComposer } from "@/components/coaching/FeedbackComposer";
import { env } from "@/lib/env";

interface CallInfo {
  call_uuid: string;
  recording_log_id?: string;
  agent?: { id: string; full_name: string | null; username: string } | null;
  campaign_id?: string | null;
  duration_sec?: number | null;
  started_at?: string | null;
}

interface ReviewShellProps {
  callUuid: string;
  call: CallInfo;
  annotations: Annotation[];
  scorecard: CallScorecard | null;
  templates: ScorecardTemplate[];
}

export function ReviewShell({
  callUuid,
  call,
  annotations: initialAnnotations,
  scorecard: initialScorecard,
  templates,
}: ReviewShellProps): React.ReactElement {
  const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations);
  const [scorecard, setScorecard] = useState<CallScorecard | null>(initialScorecard);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    initialScorecard?.template_id ?? templates[0]?.id ?? "",
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverTimestampMs, setPopoverTimestampMs] = useState(0);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | undefined>();
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"player" | "scorecard" | "feedback">("player");

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? templates[0] ?? null;
  const isLocked = scorecard?.status === "finalized";

  const agentName = call.agent?.full_name ?? call.agent?.username ?? "the agent";

  function showToast(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // ── Annotation handlers ────────────────────────────────────────────────────

  const handleAddAnnotationAtCurrentTime = useCallback(() => {
    // Without wavesurfer integration, default to 0ms
    setPopoverTimestampMs(0);
    setEditingAnnotation(undefined);
    setPopoverOpen(true);
  }, []);

  const handleAnnotationSubmit = useCallback(async (data: { text: string; tag: AnnotationTag }) => {
    setPopoverOpen(false);
    const isEdit = !!editingAnnotation;
    const url = isEdit
      ? `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/annotations/${editingAnnotation!.id}`
      : `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/annotations`;

    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp_ms: popoverTimestampMs,
        text: data.text,
        tag: data.tag,
        scorecard_id: scorecard?.id ?? null,
      }),
    });

    if (res.ok) {
      const json = await res.json() as { annotation: Annotation };
      if (isEdit) {
        setAnnotations((prev) => prev.map((a) => (a.id === json.annotation.id ? json.annotation : a)));
      } else {
        setAnnotations((prev) => [...prev, json.annotation]);
      }
    } else {
      showToast("Failed to save annotation");
    }
  }, [callUuid, editingAnnotation, popoverTimestampMs, scorecard?.id]);

  const handleDeleteAnnotation = useCallback(async (id: string) => {
    const res = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/annotations/${id}`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok || res.status === 204) {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    } else {
      showToast("Failed to delete annotation");
    }
  }, [callUuid]);

  const handleEditAnnotation = useCallback((ann: Annotation) => {
    setEditingAnnotation(ann);
    setPopoverTimestampMs(ann.timestamp_ms);
    setPopoverOpen(true);
  }, []);

  // ── Scorecard handlers ─────────────────────────────────────────────────────

  const handleSaveDraft = useCallback(async (scores: ScoreEntry[], comments: string) => {
    setIsSaving(true);
    try {
      if (!scorecard) {
        // Create
        const res = await fetch(
          `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/scorecard`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              template_id: selectedTemplateId,
              agent_id: call.agent?.id ?? null,
              scores,
              comments,
            }),
          },
        );
        if (res.ok) {
          const json = await res.json() as { scorecard: CallScorecard };
          setScorecard(json.scorecard);
          showToast("Draft saved");
        } else {
          showToast("Failed to save draft");
        }
      } else {
        // Update
        const res = await fetch(
          `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/scorecard`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scores, comments }),
          },
        );
        if (res.ok) {
          const json = await res.json() as { scorecard: CallScorecard };
          setScorecard(json.scorecard);
          showToast("Draft saved");
        } else {
          showToast("Failed to save draft");
        }
      }
    } finally {
      setIsSaving(false);
    }
  }, [callUuid, scorecard, selectedTemplateId, call.agent?.id]);

  const handleFinalize = useCallback(async (scores: ScoreEntry[], comments: string) => {
    setIsFinalizing(true);
    try {
      // Ensure draft saved first
      await handleSaveDraft(scores, comments);

      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/scorecard/finalize`,
        { method: "POST", credentials: "include" },
      );
      if (res.ok) {
        const json = await res.json() as { scorecard: CallScorecard };
        setScorecard(json.scorecard);
        showToast("Scorecard finalized and sent to agent");
      } else {
        const err = await res.json() as { error: string };
        showToast(`Finalize failed: ${err.error}`);
      }
    } finally {
      setIsFinalizing(false);
    }
  }, [callUuid, handleSaveDraft]);

  // ── Feedback handler ───────────────────────────────────────────────────────

  const handleSendFeedback = useCallback(async (body: string) => {
    setIsSendingFeedback(true);
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/sup/coaching/calls/${callUuid}/feedback`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: call.agent?.id ?? "0",
            body,
            related_scorecard_id: scorecard?.id ?? null,
          }),
        },
      );
      if (res.ok) {
        showToast("Feedback sent to agent");
      } else {
        showToast("Failed to send feedback");
      }
    } finally {
      setIsSendingFeedback(false);
    }
  }, [callUuid, call.agent?.id, scorecard?.id]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-4 right-4 z-50 rounded-md bg-gray-900 text-white px-4 py-2 text-sm shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/sup/recordings"
            className="text-sm text-blue-600 hover:underline flex items-center gap-1"
            aria-label="Back to recordings"
          >
            ← Back to Recordings
          </a>
          <div>
            <span className="text-sm font-medium text-gray-900">
              {agentName}
            </span>
            {call.started_at && (
              <span className="ml-2 text-xs text-gray-500">
                {new Date(call.started_at).toLocaleDateString()}
              </span>
            )}
            {call.duration_sec && (
              <span className="ml-2 text-xs text-gray-500">
                {Math.floor(call.duration_sec / 60)}m {call.duration_sec % 60}s
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLocked && (
            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
              Finalized
            </span>
          )}
          {!isLocked && scorecard && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
              Draft
            </span>
          )}
        </div>
      </header>

      {/* Mobile tab bar */}
      <div className="xl:hidden flex border-b border-gray-200 bg-white" role="tablist">
        {(["player", "scorecard", "feedback"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-3 text-xs font-medium capitalize transition-colors ${
              activeTab === tab
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab === "player" ? "Player + Annotations" : tab}
          </button>
        ))}
      </div>

      {/* Main layout */}
      <div className="mx-auto max-w-screen-2xl">
        {/* Desktop: three-column */}
        <div className="hidden xl:grid xl:grid-cols-[280px_1fr_380px] xl:min-h-[calc(100vh-120px)]">
          {/* Left: Annotation panel */}
          <aside className="border-r border-gray-200 bg-white flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Annotations ({annotations.length})
              </h2>
              {!isLocked && (
                <button
                  type="button"
                  onClick={handleAddAnnotationAtCurrentTime}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  aria-label="Add annotation at current playback position"
                >
                  + Add
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <AnnotationPanel
                annotations={annotations}
                activeId={activeAnnotationId}
                onSeek={(ms) => setActiveAnnotationId(
                  annotations.find((a) => a.timestamp_ms === ms)?.id ?? null,
                )}
                onEdit={isLocked ? undefined : handleEditAnnotation}
                onDelete={isLocked ? undefined : handleDeleteAnnotation}
                readOnly={false}
                isLocked={isLocked}
              />
            </div>
          </aside>

          {/* Center: Player + feedback */}
          <div className="flex flex-col border-r border-gray-200">
            {/* Audio player placeholder (integrates with R03 RecordingPlayer) */}
            <div className="border-b border-gray-100 bg-gray-900 p-4">
              <div className="rounded-md bg-gray-800 px-4 py-6 flex items-center justify-center">
                <p className="text-gray-400 text-sm">
                  {call.recording_log_id
                    ? "Audio player — load recording to begin playback"
                    : "No recording available"}
                </p>
              </div>
              {/* Annotation keyboard shortcut hint */}
              {!isLocked && (
                <p className="mt-2 text-[11px] text-gray-500 text-center">
                  Press <kbd className="px-1 py-0.5 bg-gray-700 text-gray-300 rounded text-[10px]">A</kbd> to add annotation at current time
                </p>
              )}
            </div>

            {/* Feedback composer */}
            <div className="p-4 border-t border-gray-200 mt-auto">
              <details>
                <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-800">
                  Send Feedback to {agentName}
                </summary>
                <div className="mt-3">
                  <FeedbackComposer
                    agentName={agentName}
                    onSend={handleSendFeedback}
                    isSending={isSendingFeedback}
                  />
                </div>
              </details>
            </div>
          </div>

          {/* Right: Scorecard form */}
          <div className="flex flex-col overflow-y-auto">
            <div className="px-5 py-4">
              {/* Template selector (only when no scorecard yet) */}
              {!scorecard && templates.length > 0 && (
                <div className="mb-4">
                  <label htmlFor="template-select" className="text-xs font-medium text-gray-600">
                    Select Template
                  </label>
                  <select
                    id="template-select"
                    value={selectedTemplateId}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} v{t.version}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selectedTemplate && (
                <ScorecardForm
                  template={selectedTemplate}
                  scorecard={scorecard}
                  onSave={handleSaveDraft}
                  onFinalize={handleFinalize}
                  readOnly={isLocked}
                  isSaving={isSaving}
                  isFinalizing={isFinalizing}
                />
              )}

              {!selectedTemplate && (
                <p className="text-sm text-gray-500 text-center py-8">
                  No scorecard templates available. Ask an admin to create one.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Mobile: tab content */}
        <div className="xl:hidden p-4">
          {activeTab === "player" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-md bg-gray-900 px-4 py-6 flex items-center justify-center">
                <p className="text-gray-400 text-sm">Audio player</p>
              </div>
              {!isLocked && (
                <button
                  type="button"
                  onClick={handleAddAnnotationAtCurrentTime}
                  className="w-full rounded-md border border-blue-300 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
                >
                  + Add Annotation
                </button>
              )}
              <AnnotationPanel
                annotations={annotations}
                activeId={activeAnnotationId}
                onSeek={(ms) => setActiveAnnotationId(
                  annotations.find((a) => a.timestamp_ms === ms)?.id ?? null,
                )}
                onEdit={isLocked ? undefined : handleEditAnnotation}
                onDelete={isLocked ? undefined : handleDeleteAnnotation}
                isLocked={isLocked}
              />
            </div>
          )}

          {activeTab === "scorecard" && selectedTemplate && (
            <ScorecardForm
              template={selectedTemplate}
              scorecard={scorecard}
              onSave={handleSaveDraft}
              onFinalize={handleFinalize}
              readOnly={isLocked}
              isSaving={isSaving}
              isFinalizing={isFinalizing}
            />
          )}

          {activeTab === "feedback" && (
            <FeedbackComposer
              agentName={agentName}
              onSend={handleSendFeedback}
              isSending={isSendingFeedback}
            />
          )}
        </div>
      </div>

      {/* Annotation popover */}
      <AnnotationPopover
        open={popoverOpen}
        timestampMs={popoverTimestampMs}
        initial={editingAnnotation}
        onSubmit={handleAnnotationSubmit}
        onClose={() => { setPopoverOpen(false); setEditingAnnotation(undefined); }}
      />
    </div>
  );
}
