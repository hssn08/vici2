// M03 — Admin reports index page.
// URL: /admin/reports

export const metadata = { title: "Reports · vici2 Admin" };

const REPORTS = [
  {
    href: "/admin/reports/campaign-daily",
    label: "Campaign Daily Performance",
    description: "Calls attempted, connected, drops, sales and abandon rate per campaign per day.",
  },
  {
    href: "/admin/reports/agent-productivity",
    label: "Agent Productivity",
    description: "Calls handled, ready/pause/talk/wrap times and sales per hour per agent.",
  },
  {
    href: "/admin/reports/list-health",
    label: "List Health",
    description: "Lead callable vs DNC vs TZ-blocked vs exhausted breakdown per list.",
  },
];

export default function ReportsIndexPage(): React.ReactElement {
  return (
    <main>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Reports</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Operational and admin reports. Data is cached for 5 minutes.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <a
            key={r.href}
            href={r.href}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-5 hover:bg-[var(--color-surface-muted)] transition-colors focus:rounded-lg focus:outline-2 focus:outline-[var(--color-brand-600)]"
          >
            <p className="font-medium text-[var(--color-fg)]">{r.label}</p>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{r.description}</p>
          </a>
        ))}
      </div>
    </main>
  );
}
