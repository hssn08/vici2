"use client";
// I02 — IVR edge row component.

import type { IvrEdgeDto } from "@vici2/types";
import { useState } from "react";

interface EdgeRowProps {
  ivrId: string;
  edge: IvrEdgeDto;
  allNodes: Array<{ id: string; name: string }>;
  onUpdated: () => void;
}

export function EdgeRow({ ivrId, edge, allNodes, onUpdated }: EdgeRowProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [toNodeId, setToNodeId] = useState(edge.toNodeId ?? "");

  const handleDelete = async (): Promise<void> => {
    const res = await fetch(
      `/api/admin/ivrs/${ivrId}/nodes/${edge.fromNodeId}/edges/${edge.id}`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok || res.status === 204) {
      onUpdated();
    } else {
      alert("Failed to delete edge");
    }
  };

  const handleSave = async (): Promise<void> => {
    const res = await fetch(
      `/api/admin/ivrs/${ivrId}/nodes/${edge.fromNodeId}/edges/${edge.id}`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNodeId: toNodeId || null }),
      },
    );
    if (res.ok) {
      setEditing(false);
      onUpdated();
    } else {
      alert("Failed to update edge");
    }
  };

  const targetName =
    allNodes.find((n) => n.id === edge.toNodeId)?.name ?? "(terminal)";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono px-2 py-0.5 rounded bg-[var(--color-surface-raised)] text-[var(--color-fg)]">
        {edge.onInput}
      </span>
      <span className="text-[var(--color-fg-muted)]">→</span>

      {editing ? (
        <>
          <select
            value={toNodeId}
            onChange={(e) => setToNodeId(e.target.value)}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs bg-[var(--color-surface)] text-[var(--color-fg)]"
          >
            <option value="">(terminal)</option>
            {allNodes.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
          <button
            onClick={handleSave}
            className="px-2 py-0.5 rounded bg-[var(--color-accent)] text-white text-xs"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-2 py-0.5 rounded border border-[var(--color-border)] text-xs text-[var(--color-fg-muted)]"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="text-[var(--color-fg)]">{targetName}</span>
          <button
            onClick={() => setEditing(true)}
            className="text-[var(--color-accent)] hover:underline"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            className="text-red-500 hover:underline"
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}
