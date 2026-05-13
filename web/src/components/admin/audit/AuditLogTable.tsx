"use client";

// M04 — Audit log list table with cursor pagination + filters.
//
// Fetches from GET /api/admin/audit-log with cursor-based "Load more".
// Filters: action, actor, actorKind, entity_type, from, to.
// Export button triggers CSV download.

import * as React from "react";
import { api, ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ts: string;
  row_hash: string;
  prev_hash: string;
  hash_at: string;
}

interface AuditLogListResponse {
  items: AuditLogRow[];
  nextCursor: string | null;
}

const ACTOR_KINDS = ["user", "system", "worker", "external_api"] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditLogTable(): React.ReactElement {
  const [rows, setRows] = React.useState<AuditLogRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState(false);

  // Filters
  const [action, setAction] = React.useState("");
  const [actor, setActor] = React.useState("");
  const [actorKind, setActorKind] = React.useState("");
  const [entityType, setEntityType] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const buildParams = React.useCallback(
    (cursor?: string | null) => {
      const p = new URLSearchParams({ limit: "50" });
      if (action) p.set("action", action);
      if (actor) p.set("actor", actor);
      if (actorKind) p.set("actorKind", actorKind);
      if (entityType) p.set("entity_type", entityType);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [action, actor, actorKind, entityType, from, to],
  );

  const fetchPage = React.useCallback(
    async (cursor?: string | null, replace = false) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.get<AuditLogListResponse>(
          `/api/admin/audit-log?${buildParams(cursor)}`,
        );
        setRows((prev) => (replace ? result.items : [...prev, ...result.items]));
        setNextCursor(result.nextCursor);
        setHasLoaded(true);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Failed to load audit log";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  // Initial load and filter change
  React.useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchPage(null, true);
  };

  const handleLoadMore = () => {
    void fetchPage(nextCursor);
  };

  const handleExport = () => {
    const p = new URLSearchParams({ format: "csv" });
    if (action) p.set("action", action);
    if (actor) p.set("actor", actor);
    if (actorKind) p.set("actorKind", actorKind);
    if (entityType) p.set("entity_type", entityType);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    window.location.href = `/api/admin/audit-log/export?${p.toString()}`;
  };

  return (
    <div className="space-y-4">
      {/* Filter form */}
      <form
        onSubmit={handleSearch}
        className="flex flex-wrap gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        aria-label="Audit log filters"
      >
        <input
          type="text"
          placeholder="Action prefix…"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] placeholder-[var(--color-fg-muted)] w-40"
          aria-label="Filter by action"
        />
        <input
          type="text"
          placeholder="Actor user ID"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] placeholder-[var(--color-fg-muted)] w-32"
          aria-label="Filter by actor user ID"
          pattern="\d*"
        />
        <select
          value={actorKind}
          onChange={(e) => setActorKind(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] w-36"
          aria-label="Filter by actor kind"
        >
          <option value="">All kinds</option>
          {ACTOR_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Entity type"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] placeholder-[var(--color-fg-muted)] w-28"
          aria-label="Filter by entity type"
        />
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] w-36"
          aria-label="From date"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] w-36"
          aria-label="To date"
        />
        <button
          type="submit"
          className="h-8 rounded bg-[var(--color-brand-600)] px-3 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          Filter
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors ml-auto"
          aria-label="Export as CSV"
        >
          Export CSV
        </button>
      </form>

      {/* Error state */}
      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
        <table
          role="grid"
          className="w-full min-w-[900px] text-sm"
          aria-label="Audit log rows"
          aria-busy={loading}
        >
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              {["ID", "Timestamp", "Action", "Actor kind", "Actor ID", "Entity type", "Entity ID", "Row hash"].map(
                (col) => (
                  <th
                    key={col}
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]"
                  >
                    {col}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer hover:bg-[var(--color-surface-muted)] transition-colors"
                onClick={() => {
                  window.location.href = `/admin/audit/${row.id}`;
                }}
                tabIndex={0}
                role="row"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    window.location.href = `/admin/audit/${row.id}`;
                  }
                }}
                aria-label={`Audit row ${row.id}: ${row.action}`}
              >
                <td className="px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]">{row.id}</td>
                <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-fg)]">
                  {new Date(row.ts).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--color-fg)]">{row.action}</td>
                <td className="px-3 py-2 text-xs">
                  <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[var(--color-fg-muted)]">
                    {row.actor_kind}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-[var(--color-fg-muted)]">
                  {row.actor_user_id ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-[var(--color-fg)]">{row.entity_type}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]">
                  {row.entity_id ?? "—"}
                </td>
                <td
                  className="px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]"
                  title={row.row_hash}
                >
                  {row.row_hash.slice(0, 12)}…
                </td>
              </tr>
            ))}

            {hasLoaded && rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-8 text-center text-sm text-[var(--color-fg-muted)]"
                >
                  No audit log rows found.
                </td>
              </tr>
            )}

            {loading && (
              <tr aria-hidden>
                <td colSpan={8} className="px-3 py-4">
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-8 animate-pulse rounded bg-[var(--color-surface-muted)]"
                      />
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {nextCursor && !loading && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleLoadMore}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
