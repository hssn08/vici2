"use client";

// X03 — Multi-FS Campaign Affinity: FS Node Admin Page.
//
// Route: (admin)/admin/infrastructure/fs-nodes
// Provides read-only health table for admin role; drain/activate/add/re-pin
// actions are shown only to super_admin (infra:fs_node:edit).
//
// X03 PLAN §7.

import { useEffect, useState, useCallback } from "react";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type FsNodeStatus = "ACTIVE" | "DRAINING" | "UNHEALTHY" | "OFFLINE";

interface FsNodeRow {
  id: number;
  name: string;
  host: string;
  eslHost: string;
  eslPort: number;
  weight: number;
  status: FsNodeStatus;
  lastHeartbeat: string | null;
  campaignCount: number;
  activeCalls: number;
  eslConnected: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Status Badge
// ──────────────────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<FsNodeStatus, string> = {
  ACTIVE:    "bg-green-100 text-green-800 border border-green-200",
  DRAINING:  "bg-yellow-100 text-yellow-800 border border-yellow-200",
  UNHEALTHY: "bg-red-100 text-red-800 border border-red-200",
  OFFLINE:   "bg-gray-100 text-gray-500 border border-gray-200",
};

function StatusBadge({ status }: { status: FsNodeStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      {status}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────────────────────────────────────

export default function FsNodesPage() {
  const [nodes, setNodes] = useState<FsNodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/infrastructure/fs-nodes", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNodes(data.nodes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load FS nodes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNodes();
    // Poll every 15 s.
    const id = setInterval(() => { void fetchNodes(); }, 15_000);
    return () => clearInterval(id);
  }, [fetchNodes]);

  async function setStatus(nodeId: number, action: "drain" | "activate") {
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/infrastructure/fs-nodes/${nodeId}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      await fetchNodes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Loading FS nodes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-red-600 bg-red-50 rounded border border-red-200">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">FreeSWITCH Nodes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Campaign-to-FS affinity. Campaigns are pinned to one FS instance for
            conference invariant enforcement (X03).
          </p>
        </div>
        <button
          onClick={() => void fetchNodes()}
          className="text-sm text-gray-500 hover:text-gray-700 border rounded px-3 py-1"
        >
          Refresh
        </button>
      </div>

      {actionError && (
        <div className="p-3 text-sm text-red-700 bg-red-50 rounded border border-red-200">
          {actionError}
        </div>
      )}

      {nodes.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          No FS nodes configured. Add a node to enable campaign affinity.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {[
                  "Name", "Host", "ESL Host:Port", "Weight", "Status",
                  "Campaigns", "Active Calls", "Last Heartbeat", "Actions",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {nodes.map((node) => (
                <tr key={node.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{node.name}</td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">{node.host}</td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                    {node.eslHost}:{node.eslPort}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{node.weight}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={node.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{node.campaignCount}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className={node.activeCalls > 0 ? "font-semibold text-blue-600" : ""}>
                      {node.activeCalls}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {node.lastHeartbeat
                      ? new Date(node.lastHeartbeat).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {node.status === "ACTIVE" && (
                        <button
                          onClick={() => void setStatus(node.id, "drain")}
                          className="text-xs text-yellow-700 hover:text-yellow-900 border border-yellow-300 rounded px-2 py-0.5"
                        >
                          Drain
                        </button>
                      )}
                      {(node.status === "DRAINING" || node.status === "UNHEALTHY") && (
                        <button
                          onClick={() => void setStatus(node.id, "activate")}
                          className="text-xs text-green-700 hover:text-green-900 border border-green-300 rounded px-2 py-0.5"
                        >
                          Activate
                        </button>
                      )}
                      <a
                        href={`/admin/infrastructure/fs-nodes/${node.id}`}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        Detail
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Auto-refreshes every 15 s. Node status is updated by the dialer health-check
        worker every 10 s via ESL heartbeat. UNHEALTHY nodes are only re-activated by
        admin action after verifying ESL connectivity.
      </p>
    </div>
  );
}
