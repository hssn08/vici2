"use client";

// M03 — Campaign daily performance report page.
// URL: /admin/reports/campaign-daily

import { useState, useEffect } from "react";
import { DateRangePicker } from "@/components/admin/reports/DateRangePicker";
import { ReportTable } from "@/components/admin/reports/ReportTable";
import { ExportButton } from "@/components/admin/reports/ExportButton";

interface CampaignDailyRow {
  campaignId: string;
  reportDate: string;
  callsAttempted: number;
  callsConnected: number;
  contacts: number;
  sales: number;
  drops: number;
  dropRatePct: number | null;
  avgCallDurationSec: number | null;
  abandonRatePct: number | null;
}

const COLUMNS = [
  { key: "reportDate" as const, header: "Date" },
  { key: "campaignId" as const, header: "Campaign" },
  { key: "callsAttempted" as const, header: "Attempted", align: "right" as const },
  { key: "callsConnected" as const, header: "Connected", align: "right" as const },
  { key: "contacts" as const, header: "Contacts", align: "right" as const },
  { key: "sales" as const, header: "Sales", align: "right" as const },
  { key: "drops" as const, header: "Drops", align: "right" as const },
  {
    key: "dropRatePct" as const,
    header: "Drop %",
    align: "right" as const,
    format: (v: CampaignDailyRow["dropRatePct"]) => (v != null ? `${v.toFixed(2)}%` : "—"),
  },
  {
    key: "avgCallDurationSec" as const,
    header: "Avg Duration",
    align: "right" as const,
    format: (v: CampaignDailyRow["avgCallDurationSec"]) => (v != null ? `${Math.round(v)}s` : "—"),
  },
  {
    key: "abandonRatePct" as const,
    header: "Abandon %",
    align: "right" as const,
    format: (v: CampaignDailyRow["abandonRatePct"]) => (v != null ? `${v.toFixed(2)}%` : "—"),
  },
];

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export default function CampaignDailyPage(): React.ReactElement {
  const { from: defaultFrom, to: defaultTo } = defaultDateRange();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [campaign, setCampaign] = useState("");
  const [rows, setRows] = useState<CampaignDailyRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchData(): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (campaign) params.set("campaign", campaign);
      const resp = await fetch(`/api/admin/reports/campaign-daily?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json() as { data: CampaignDailyRow[] };
      setRows(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void fetchData(); }, [from, to, campaign]); // fetchData is defined in render scope

  return (
    <main>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Campaign Daily Performance</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Per-campaign daily aggregation. Contacts = human-answered calls (FCC denominator).
          </p>
        </div>
        <ExportButton
          baseUrl="/api/admin/reports/campaign-daily/export.csv"
          params={{ from, to, campaign: campaign || undefined }}
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
            htmlFor="campaign-filter"
            className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]"
          >
            Campaign (optional)
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
