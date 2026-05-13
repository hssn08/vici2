"use client";

/**
 * FeedbackComposer — feedback text input + send button.
 * S05 PLAN §3.1 (bottom panel)
 */

import * as React from "react";

interface FeedbackComposerProps {
  agentName?: string;
  onSend: (body: string) => Promise<void>;
  isSending?: boolean;
}

export function FeedbackComposer({
  agentName,
  onSend,
  isSending = false,
}: FeedbackComposerProps): React.ReactElement {
  const [body, setBody] = React.useState("");

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!body.trim()) return;
    await onSend(body.trim());
    setBody("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor="feedback-body" className="text-xs font-medium text-gray-600">
        Send coaching note to {agentName ?? "agent"}
      </label>
      <div className="flex gap-2">
        <textarea
          id="feedback-body"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Send coaching note to ${agentName ?? "agent"}…`}
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          aria-label="Coaching note"
        />
        <button
          type="submit"
          disabled={isSending || !body.trim()}
          className="self-end rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {isSending ? "Sending…" : "Send Feedback"}
        </button>
      </div>
    </form>
  );
}
