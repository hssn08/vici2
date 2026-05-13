// M01 — Admin dashboard landing page.
//
// Phase 1: placeholder with quick-links to implemented sections.
// M08 fills in the KPI tiles (Tremor AreaChart / Metric cards).

export const metadata = { title: "Dashboard · vici2 Admin" };

export default function AdminLandingPage(): React.ReactElement {
  return (
    <main>
      <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
        Admin Dashboard
      </h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Welcome to the vici2 admin panel. Use the sidebar to navigate.
      </p>

      {/* Quick links */}
      <nav aria-label="Quick navigation" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { href: "/admin/users", label: "Users", description: "Manage user accounts & roles" },
          { href: "/admin/settings", label: "Settings", description: "Tenant policy & compliance" },
          { href: "/admin/campaigns", label: "Campaigns", description: "Dialing campaigns (M02)" },
          { href: "/admin/leads", label: "Leads", description: "Lead lists (M03 + D04)" },
          { href: "/admin/recordings", label: "Recordings", description: "Call recordings (R03)" },
          { href: "/admin/reports", label: "Reports", description: "Analytics & exports (M08)" },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="rounded-lg border bg-[var(--color-surface-elevated)] p-4 hover:bg-[var(--color-surface-muted)] transition-colors focus:rounded-lg focus:outline-2 focus:outline-[var(--color-brand-600)]"
          >
            <p className="font-medium text-[var(--color-fg)]">{item.label}</p>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{item.description}</p>
          </a>
        ))}
      </nav>
    </main>
  );
}
