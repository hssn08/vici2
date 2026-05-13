"use client";

// M03 — List health report page.
// URL: /admin/reports/list-health

import { useState, useEffect } from "react";
import { ReportTable } from "@/components/admin/reports/ReportTable";
import { ExportButton } from "@/components/admin/reports/ExportButton";

interface ListHealthRow {
  listId: string;
  listName: string;
  campaignId: string | null;
  leadsTotal: number;
  leadsCallable: number;
  leadsDnc: number;
  leadsTzBlocked: number;
  leadsNoAttempts: number;
  leadsExhausted: number;
  lastDialAt: string | null;
}

const COLUMNS = [
  { key: "listName" as const, header: "List" },
  { key: "campaignId" as const, header: "Campaign" },
  { key: "leadsTotal" as const, header: "Total", align: "right" as const },
  { key: "leadsCallable" as const, header: "Callable", align: "right" as const },
  { key: "leadsDnc" as const, header: "DNC", align: "right" as const },
  { key: "leadsTzBlocked" as const, header: "TZ Blocked", align: "right" as const },
  { key: "leadsNoAttempts" as const, header: "Never Called", align: "right" as const },
  { key: "leadsExhausted" as const, header: "Exhausted", align: "right" as const },
  {
    key: "lastDialAt" as const,
    header: "Last Dialed",
    format: (v: ListHealthRow["lastDialAt"]) => v ? String(v).slice(0, 19).replace("T", " ") : "—",
  },
];

export default function ListHealthPage(): React.ReactElement {
  const [campaign, setCampaign] = useState("");
  const [rows, setRows] = useState<ListHealthRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchData(): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (campaign) params.set("campaign", campaign);
      const resp = await fetch(`/api/admin/reports/list-health?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json() as { data: ListHealthRow[] };
      setRows(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void fetchData(); }, [campaign]); // fetchData is defined in render scope

  return (
    <main>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">List Health</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Lead status breakdown per list: callable vs DNC vs TZ-blocked vs exhausted.
          </p>
        </div>
        <ExportButton
          baseUrl="/api/admin/reports/list-health/export.csv"
          params={{ campaign: campaign || undefined }}
        />
      </div>

      <div className="mb-4">
        <label
          htmlFor="campaign-filter"
          className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]"
        >
          Filter by campaign (optional)
        </label>
        <input
          id="campaign-filter"
          type="text"
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          placeholder="e.g. CAMP-A"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-brand-600)] focus:outline-none"
        />
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ReportTable
        columns={COLUMNS}
        rows={rows}
        isLoading={isLoading}
        emptyMessage="No lists found for the selected campaign."
      />
    </main>
  );
}
