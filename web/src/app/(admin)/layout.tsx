// M01 — Admin route group layout.
//
// Server component shell for all /(admin)/* pages.  The AdminShell client
// component renders the sidebar + topbar.  Role gating (presence-only for
// Phase 1; full F05 JWT verify once JWKS env is published) happens in
// src/middleware.ts.

import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/AdminShell";

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-[var(--color-surface)]">
      <AdminShell>{children}</AdminShell>
    </div>
  );
}
