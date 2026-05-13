"use client";
// I02 — IVR node card component.

import type { IvrNodeDto, IvrEdgeDto } from "@vici2/types";
import { TERMINAL_NODE_TYPES } from "@vici2/types";
import { EdgeRow } from "./EdgeRow";
import { PromptUpload } from "./PromptUpload";
import { useState } from "react";

interface NodeCardProps {
  ivrId: string;
  node: IvrNodeDto;
  allNodes: Array<{ id: string; name: string }>;
  isEntry: boolean;
  onNodeUpdated: () => void;
  onNodeDeleted: () => void;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  collect: "Collect DTMF",
  lang_select: "Language Select",
  terminal_ingroup: "Route to Queue",
  terminal_hangup: "Hangup",
  terminal_voicemail: "Voicemail",
  terminal_transfer: "External Transfer",
  terminal_callback: "Callback Offer",
};

export function NodeCard({
  ivrId,
  node,
  allNodes,
  isEntry,
  onNodeUpdated,
  onNodeDeleted,
}: NodeCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [addingEdge, setAddingEdge] = useState(false);
  const [edgeInput, setEdgeInput] = useState("");
  const [edgeTo, setEdgeTo] = useState("");

  const isTerminal = TERMINAL_NODE_TYPES.has(node.nodeType as never);

  const handleDeleteNode = async (): Promise<void> => {
    if (!confirm(`Delete node "${node.name}"?`)) return;
    const res = await fetch(`/api/admin/ivrs/${ivrId}/nodes/${node.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok || res.status === 204) {
      onNodeDeleted();
    } else {
      alert("Failed to delete node");
    }
  };

  const handleAddEdge = async (): Promise<void> => {
    if (!edgeInput.trim()) return;
    const res = await fetch(`/api/admin/ivrs/${ivrId}/nodes/${node.id}/edges`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onInput: edgeInput.trim(),
        toNodeId: edgeTo ? edgeTo : null,
        sortOrder: node.edges.length,
      }),
    });
    if (res.ok) {
      setAddingEdge(false);
      setEdgeInput("");
      setEdgeTo("");
      onNodeUpdated();
    } else {
      const body = await res.json() as { message?: string };
      alert(body.message ?? "Failed to add edge");
    }
  };

  return (
    <div
      className={`rounded border ${isEntry ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"} bg-[var(--color-surface)] mb-4`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-fg)]">{node.name}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]">
            {NODE_TYPE_LABELS[node.nodeType] ?? node.nodeType}
          </span>
          {isEntry && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-accent)] text-white">
              Entry
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteNode();
            }}
            className="text-xs text-red-500 hover:underline"
          >
            Delete
          </button>
          <span className="text-[var(--color-fg-muted)] text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-[var(--color-border)]">
          {/* Node ID */}
          <p className="text-xs text-[var(--color-fg-muted)] mt-2">ID: {node.id}</p>

          {/* Terminal action target */}
          {isTerminal && node.nodeType !== "terminal_hangup" && (
            <div>
              <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">
                Action Target {node.nodeType === "terminal_ingroup" ? "(Queue ID)" : node.nodeType === "terminal_transfer" ? "(E.164 number)" : "(ID)"}
              </label>
              <p className="text-sm text-[var(--color-fg)]">{node.actionTarget ?? "(none)"}</p>
            </div>
          )}

          {/* Collect config (non-terminal) */}
          {!isTerminal && (
            <div className="grid grid-cols-3 gap-3 text-xs text-[var(--color-fg-muted)]">
              <div>Timeout: {node.timeoutMs}ms</div>
              <div>Invalid max: {node.invalidMax}</div>
              <div>Digits: {node.collectMin}–{node.collectMax}</div>
            </div>
          )}

          {/* Prompts */}
          {!isTerminal && (
            <div>
              <p className="text-xs font-medium text-[var(--color-fg-muted)] mb-2">Prompts</p>
              {node.prompts.length === 0 ? (
                <p className="text-xs text-[var(--color-fg-muted)] italic">No prompts uploaded.</p>
              ) : (
                <ul className="space-y-1 mb-2">
                  {node.prompts.map((p) => (
                    <li key={p.id} className="text-xs text-[var(--color-fg-muted)]">
                      [{p.lang}] {p.fileUri} {p.durationMs ? `(${p.durationMs}ms)` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <PromptUpload ivrId={ivrId} nodeId={node.id} onUploaded={onNodeUpdated} />
            </div>
          )}

          {/* Edges */}
          {!isTerminal && (
            <div>
              <p className="text-xs font-medium text-[var(--color-fg-muted)] mb-2">Edges</p>
              {node.edges.length === 0 ? (
                <p className="text-xs text-[var(--color-fg-muted)] italic">No edges yet.</p>
              ) : (
                <div className="space-y-2">
                  {node.edges.map((edge) => (
                    <EdgeRow
                      key={edge.id}
                      ivrId={ivrId}
                      edge={edge}
                      allNodes={allNodes}
                      onUpdated={onNodeUpdated}
                    />
                  ))}
                </div>
              )}

              {addingEdge ? (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    placeholder="Input (1, *, __TIMEOUT__, ...)"
                    value={edgeInput}
                    onChange={(e) => setEdgeInput(e.target.value)}
                    className="flex-1 min-w-[180px] rounded border border-[var(--color-border)] px-2 py-1 text-xs bg-[var(--color-surface)] text-[var(--color-fg)]"
                  />
                  <select
                    value={edgeTo}
                    onChange={(e) => setEdgeTo(e.target.value)}
                    className="rounded border border-[var(--color-border)] px-2 py-1 text-xs bg-[var(--color-surface)] text-[var(--color-fg)]"
                  >
                    <option value="">→ (terminal / same)</option>
                    {allNodes.filter((n) => n.id !== node.id).map((n) => (
                      <option key={n.id} value={n.id}>{n.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAddEdge}
                    className="px-2 py-1 rounded bg-[var(--color-accent)] text-white text-xs"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setAddingEdge(false)}
                    className="px-2 py-1 rounded border border-[var(--color-border)] text-xs text-[var(--color-fg-muted)]"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingEdge(true)}
                  className="mt-2 text-xs text-[var(--color-accent)] hover:underline"
                >
                  + Add edge
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
