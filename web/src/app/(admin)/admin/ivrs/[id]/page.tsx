"use client";
// I02 — IVR detail / tree editor page.
// Route: /admin/ivrs/[id]

import { useEffect, useState } from "react";
import { NodeCard } from "./NodeCard";
import type { IvrDetailDto, IvrNodeDto } from "@vici2/types";

const NODE_TYPES = [
  "collect",
  "lang_select",
  "terminal_ingroup",
  "terminal_hangup",
  "terminal_voicemail",
  "terminal_transfer",
  "terminal_callback",
] as const;

interface PageProps {
  params: { id: string };
}

async function fetchIvr(id: string): Promise<IvrDetailDto> {
  const res = await fetch(`/api/admin/ivrs/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error("IVR not found");
  return res.json() as Promise<IvrDetailDto>;
}

export default function IvrDetailPage({ params }: PageProps): React.ReactElement {
  const { id } = params;
  const [ivr, setIvr] = useState<IvrDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-node form state
  const [addingNode, setAddingNode] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeType, setNewNodeType] = useState<string>("collect");
  const [newNodeTarget, setNewNodeTarget] = useState("");
  const [newNodeIsEntry, setNewNodeIsEntry] = useState(false);
  const [savingNode, setSavingNode] = useState(false);

  const load = (): void => {
    setLoading(true);
    fetchIvr(id)
      .then(setIvr)
      .catch((e: unknown) => setError(String((e as Error).message)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  const handleAddNode = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSavingNode(true);
    try {
      const res = await fetch(`/api/admin/ivrs/${id}/nodes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newNodeName,
          nodeType: newNodeType,
          actionTarget: newNodeTarget || null,
          isEntryNode: newNodeIsEntry || !ivr?.entryNodeId,
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? "Failed to create node");
      }
      setAddingNode(false);
      setNewNodeName("");
      setNewNodeType("collect");
      setNewNodeTarget("");
      setNewNodeIsEntry(false);
      load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSavingNode(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }
  if (error || !ivr) {
    return <p className="text-sm text-red-500">{error ?? "IVR not found"}</p>;
  }

  const allNodesSummary = ivr.nodes.map((n: IvrNodeDto) => ({ id: n.id, name: n.name }));

  return (
    <main>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{ivr.name}</h1>
          {ivr.description && (
            <p className="text-sm text-[var(--color-fg-muted)] mt-1">{ivr.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-[var(--color-fg-muted)]">
              Depth: {ivr.maxDepthValidated} / 3
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ivr.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
              {ivr.active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>
        <a
          href="/admin/ivrs"
          className="text-sm text-[var(--color-fg-muted)] hover:underline"
        >
          ← All IVRs
        </a>
      </div>

      {/* Node tree */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-medium text-[var(--color-fg)]">
            Nodes ({ivr.nodes.length})
          </h2>
          <button
            onClick={() => setAddingNode(!addingNode)}
            className="px-3 py-1 rounded bg-[var(--color-accent)] text-white text-sm"
          >
            + Add Node
          </button>
        </div>

        {addingNode && (
          <form onSubmit={handleAddNode} className="mb-4 rounded border border-[var(--color-border)] p-4 bg-[var(--color-surface-raised)] space-y-3">
            <h3 className="text-sm font-medium text-[var(--color-fg)]">Add Node</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[var(--color-fg-muted)] mb-1">Name</label>
                <input
                  type="text"
                  value={newNodeName}
                  onChange={(e) => setNewNodeName(e.target.value)}
                  required
                  className="w-full rounded border border-[var(--color-border)] px-2 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-fg)]"
                  placeholder="Main Menu"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--color-fg-muted)] mb-1">Type</label>
                <select
                  value={newNodeType}
                  onChange={(e) => setNewNodeType(e.target.value)}
                  className="w-full rounded border border-[var(--color-border)] px-2 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-fg)]"
                >
                  {NODE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            {(newNodeType === "terminal_ingroup" || newNodeType === "terminal_transfer" || newNodeType === "terminal_voicemail" || newNodeType === "terminal_callback") && (
              <div>
                <label className="block text-xs text-[var(--color-fg-muted)] mb-1">
                  Action Target {newNodeType === "terminal_ingroup" ? "(Queue ID, e.g. SALES)" : newNodeType === "terminal_transfer" ? "(E.164 number)" : "(ID)"}
                </label>
                <input
                  type="text"
                  value={newNodeTarget}
                  onChange={(e) => setNewNodeTarget(e.target.value)}
                  className="w-full rounded border border-[var(--color-border)] px-2 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-fg)]"
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isEntry"
                checked={newNodeIsEntry}
                onChange={(e) => setNewNodeIsEntry(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="isEntry" className="text-xs text-[var(--color-fg-muted)]">
                Set as entry node
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={savingNode || !newNodeName.trim()}
                className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-sm disabled:opacity-50"
              >
                {savingNode ? "Adding…" : "Add Node"}
              </button>
              <button
                type="button"
                onClick={() => setAddingNode(false)}
                className="px-3 py-1.5 rounded border border-[var(--color-border)] text-sm text-[var(--color-fg-muted)]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {ivr.nodes.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-border)] p-8 text-center">
            <p className="text-sm text-[var(--color-fg-muted)]">
              No nodes yet. Add the first node to start building your IVR tree.
            </p>
          </div>
        ) : (
          <div>
            {/* Show entry node first */}
            {[
              ...ivr.nodes.filter((n: IvrNodeDto) => n.id === ivr.entryNodeId),
              ...ivr.nodes.filter((n: IvrNodeDto) => n.id !== ivr.entryNodeId),
            ].map((node: IvrNodeDto) => (
              <NodeCard
                key={node.id}
                ivrId={id}
                node={node}
                allNodes={allNodesSummary}
                isEntry={node.id === ivr.entryNodeId}
                onNodeUpdated={load}
                onNodeDeleted={load}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
