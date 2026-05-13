"use client";

import * as React from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/stores/auth";
import { useUiStore } from "@/lib/stores/ui";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { Button } from "@/components/ui/button";
import { AgentStateWidget } from "@/components/agent/AgentStateWidget";
import { ConnectionIndicator } from "@/components/agent/ConnectionIndicator";

export function TopNav(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <header
      role="banner"
      className="flex h-14 items-center justify-between border-b bg-[var(--color-surface-elevated)] px-4"
    >
      {/* Left: sidebar toggle + brand */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle navigation"
          onClick={toggleSidebar}
        >
          <span aria-hidden>≡</span>
        </Button>
        <Link
          href="/dashboard"
          className="text-base font-semibold text-[var(--color-fg)]"
        >
          vici2
        </Link>
      </div>

      {/* Center: agent state widget */}
      <div className="flex items-center gap-3">
        <AgentStateWidget />
      </div>

      {/* Right: connection indicator + tenant/user info + theme + logout */}
      <div className="flex items-center gap-3">
        <ConnectionIndicator />

        {user ? (
          <span
            className="hidden text-sm text-[var(--color-fg-muted)] sm:inline"
            title={`Tenant: ${user.tenantId}`}
          >
            {user.displayName} · {user.role}
          </span>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle color theme"
        >
          {theme === "dark" ? "Light" : "Dark"}
        </Button>

        <LogoutButton />
      </div>
    </header>
  );
}
