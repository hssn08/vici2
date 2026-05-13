"use client";

// M03 — Agent productivity report page.
// URL: /admin/reports/agent-productivity

import { useState, useEffect } from "react";
import { DateRangePicker } from "@/components/admin/reports/DateRangePicker";
import { ReportTable } from "@/components/admin/reports/ReportTable";
import { ExportButton } from "@/components/admin/reports/ExportButton";

interface AgentProductivityRow {
  userId: string;
  username: string;
  reportDate: string;
  callsHandled: number;
  timeReadySec: number;
  timePausedSec: number;
  timeTalkingSec: number;
  timeAcwSec: number;
  sales: number;
  salesPerHour: number | null;
}

function secToHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const COLUMNS = [
  { key: "reportDate" as const, header: "Date" },
  { key: "username" as const, header: "Agent" },
  { key: "callsHandled" as const, header: "Calls", align: "right" as const },
  {
    key: "timeReadySec" as const,
    header: "Ready",
    align: "right" as const,
    format: (v: AgentProductivityRow["timeReadySec"]) => secToHms(Number(v ?? 0)),
  },
  {
    key: "timePausedSec" as const,
    header: "Paused",
    align: "right" as const,
    format: (v: AgentProductivityRow["timePausedSec"]) => secToHms(Number(v ?? 0)),
  },
  {
    key: "timeTalkingSec" as const,
    header: "Talking",
    align: "right" as const,
    format: (v: AgentProductivityRow["timeTalkingSec"]) => secToHms(Number(v ?? 0)),
  },
  {
    key: "timeAcwSec" as const,
    header: "Wrap (ACW)",
    align: "right" as const,
    format: (v: AgentProductivityRow["timeAcwSec"]) => secToHms(Number(v ?? 0)),
  },
  { key: "sales" as const, header: "Sales", align: "right" as const },
  {
    key: "salesPerHour" as const,
    header: "Sales/hr",
    align: "right" as const,
    format: (v: AgentProductivityRow["salesPerHour"]) => (v != null ? v.toFixed(2) : "—"),
  },
];

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default function AgentProductivityPage(): React.ReactElement {
  const { from: defaultFrom, to: defaultTo } = defaultDateRange();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [agent, setAgent] = useState("");
  const [rows, setRows] = useState<AgentProductivityRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchData(): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (agent) params.set("agent", agent);
      const resp = await fetch(`/api/admin/reports/agent-productivity?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json() as { data: AgentProductivityRow[] };
      setRows(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void fetchData(); }, [from, to, agent]); // fetchData is defined in render scope

  return (
    <main>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Agent Productivity</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Per-agent daily aggregation of calls, time segments, and sales.
          </p>
        </div>
        <ExportButton
          baseUrl="/api/admin/reports/agent-productivity/export.csv"
          params={{ from, to, agent: agent || undefined }}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <DateRangePicker
          from={from}
          to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
        />
        <div>
          <label
            htmlFor="agent-filter"
            className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]"
          >
            Agent user ID (optional)
          </label>
          <input
            id="agent-filter"
            type="text"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="e.g. 42"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-brand-600)] focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ReportTable columns={COLUMNS} rows={rows} isLoading={isLoading} />
    </main>
  );
}
