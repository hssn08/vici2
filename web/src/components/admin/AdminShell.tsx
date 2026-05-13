"use client";

// M01 — Admin shell layout (sidebar + topbar + content area).
//
// This client component is responsible for:
//   - Persistent collapsible sidebar with RBAC-filtered nav items
//   - Top bar with user info, theme toggle, and logout
//   - Mobile hamburger (sidebar hidden on < md)
//
// RBAC: nav items are filtered by the session user's role. In Phase 1 the
// role comes from useAuthStore; in Phase 4 we swap in the CASL abilityFromUser
// check once the packages/auth package lands.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/lib/stores/auth";
import { useUiStore } from "@/lib/stores/ui";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Nav configuration (Phase 1 — role-checked at render time)
// ---------------------------------------------------------------------------

interface NavItem {
  key: string;
  label: string;
  href: string;
  /** Minimum role required (hierarchical check) */
  minRole: "admin" | "super_admin";
}

const ADMIN_NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/admin", minRole: "admin" },
  { key: "users", label: "Users", href: "/admin/users", minRole: "admin" },
  { key: "settings", label: "Settings", href: "/admin/settings", minRole: "admin" },
  // Placeholders for downstream modules (M02–M08 fill page contents)
  { key: "campaigns", label: "Campaigns", href: "/admin/campaigns", minRole: "admin" },
  { key: "leads", label: "Leads", href: "/admin/leads", minRole: "admin" },
  { key: "carriers", label: "Carriers", href: "/admin/carriers", minRole: "admin" },
  { key: "dids", label: "DIDs", href: "/admin/dids", minRole: "admin" },
  { key: "dnc", label: "DNC", href: "/admin/dnc", minRole: "admin" },
  { key: "statuses", label: "Statuses", href: "/admin/statuses", minRole: "admin" },
  { key: "pause-codes", label: "Pause Codes", href: "/admin/pause-codes", minRole: "admin" },
  { key: "scripts", label: "Scripts", href: "/admin/scripts", minRole: "admin" },
  { key: "recordings", label: "Recordings", href: "/admin/recordings", minRole: "admin" },
  { key: "reports", label: "Reports", href: "/admin/reports", minRole: "admin" },
  // W02 — Jobs queue admin (supervisor+ can view)
  { key: "jobs", label: "Job Queues", href: "/admin/jobs", minRole: "admin" },
];

const ROLE_LEVEL: Record<string, number> = {
  super_admin: 40,
  admin: 30,
  supervisor: 20,
  agent: 10,
  integrator: 0,
};

function canAccess(userRole: string | undefined, minRole: string): boolean {
  if (!userRole) return false;
  return (ROLE_LEVEL[userRole] ?? 0) >= (ROLE_LEVEL[minRole] ?? 99);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function AdminSidebar({
  collapsed,
  onClose,
}: {
  collapsed: boolean;
  onClose: () => void;
}): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();

  const visibleItems = ADMIN_NAV.filter((item) =>
    canAccess(user?.role, item.minRole),
  );

  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden
          onClick={onClose}
        />
      )}

      <nav
        id="admin-sidebar"
        aria-label="Admin navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-[var(--color-surface-elevated)] transition-transform duration-200",
          "md:static md:translate-x-0",
          collapsed ? "-translate-x-full" : "translate-x-0",
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Link
            href="/admin"
            className="text-base font-bold text-[var(--color-brand-600)]"
            aria-label="vici2 Admin home"
          >
            vici2
          </Link>
          <span className="rounded bg-[var(--color-brand-100)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-brand-700)]">
            Admin
          </span>
        </div>

        {/* Nav items */}
        <ul role="list" className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {visibleItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-[var(--color-brand-100)] text-[var(--color-brand-700)]"
                      : "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* User info at bottom */}
        {user ? (
          <div className="border-t px-4 py-3 text-xs text-[var(--color-fg-muted)]">
            <p className="font-medium text-[var(--color-fg)] truncate">{user.displayName}</p>
            <p className="capitalize">{user.role}</p>
          </div>
        ) : null}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function AdminTopBar({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-[var(--color-surface-elevated)] px-4"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle sidebar navigation"
        aria-controls="admin-sidebar"
        onClick={onToggleSidebar}
      >
        <span aria-hidden className="text-lg">≡</span>
      </Button>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </Button>
        {user ? (
          <span
            className="hidden text-sm text-[var(--color-fg-muted)] sm:block"
            aria-label={`Signed in as ${user.displayName}`}
          >
            {user.displayName}
          </span>
        ) : null}
        <LogoutButton />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function AdminShell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  const handleToggle = (): void => setSidebarOpen((v) => !v);
  const handleClose = (): void => setSidebarOpen(false);

  return (
    <div className="flex min-h-screen">
      <AdminSidebar collapsed={!sidebarOpen} onClose={handleClose} />

      <div className="flex flex-1 flex-col min-w-0">
        <AdminTopBar onToggleSidebar={handleToggle} />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto p-6"
        >
          {/* Skip-nav target for keyboard users (WCAG 2.4.1) */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-[var(--color-brand-600)] focus:px-4 focus:py-2 focus:text-white"
          >
            Skip to main content
          </a>
          {children}
        </main>
      </div>
    </div>
  );
}
