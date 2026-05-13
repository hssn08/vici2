"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

interface NavLink {
  label: string;
  href: string;
}

const AGENT_LINKS: NavLink[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Dial", href: "/dial" },
  { label: "Active Call", href: "/call" },
  { label: "Leads", href: "/leads" },
  { label: "Callbacks", href: "/callbacks" },
  { label: "Settings", href: "/settings" },
];

export function SideNav({
  links = AGENT_LINKS,
}: {
  links?: NavLink[];
}): React.ReactElement {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "shrink-0 border-r bg-[var(--color-surface)] transition-[width] duration-150",
        collapsed ? "w-12" : "w-56",
      )}
    >
      <ul className="flex flex-col gap-1 p-2">
        {links.map((l) => {
          const active = pathname === l.href;
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-[var(--color-brand-100)] font-medium text-[var(--color-brand-700)]"
                    : "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]",
                )}
                title={collapsed ? l.label : undefined}
              >
                {collapsed ? l.label.charAt(0) : l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
