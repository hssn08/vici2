"use client";

// M05 — Settings tab switcher.
//
// WCAG 2.2 AA compliant:
//   - role="tablist" + role="tab" + role="tabpanel"
//   - aria-selected, aria-controls, aria-labelledby wired
//   - Arrow key navigation (Left/Right moves focus between tabs)
//   - Home/End jump to first/last tab
//   - Tab key leaves the tablist (natural flow)

import * as React from "react";
import { cn } from "@/lib/utils";

export interface Tab {
  key: string;
  label: string;
  panel: React.ReactNode;
}

interface SettingsTabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function SettingsTabs({
  tabs,
  defaultTab,
}: SettingsTabsProps): React.ReactElement {
  const [activeKey, setActiveKey] = React.useState<string>(
    defaultTab ?? tabs[0]?.key ?? "",
  );
  const tabRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const activeIndex = tabs.findIndex((t) => t.key === activeKey);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number): void => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActiveKey(tabs[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div>
      {/* Tab list */}
      <div
        role="tablist"
        aria-label="Settings categories"
        className="flex gap-1 border-b overflow-x-auto"
      >
        {tabs.map((tab, idx) => (
          <button
            key={tab.key}
            id={`tab-${tab.key}`}
            role="tab"
            aria-selected={tab.key === activeKey}
            aria-controls={`tabpanel-${tab.key}`}
            tabIndex={tab.key === activeKey ? 0 : -1}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            onClick={() => setActiveKey(tab.key)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              "shrink-0 rounded-t-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand-600)]",
              tab.key === activeKey
                ? "border-b-2 border-[var(--color-brand-600)] text-[var(--color-brand-700)] -mb-px"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels — only the active panel is rendered */}
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`tabpanel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.key}`}
          hidden={tab.key !== activeKey}
          tabIndex={0}
          className="pt-6 focus:outline-none"
        >
          {tab.key === activeKey && tab.panel}
        </div>
      ))}

      {/* sr-only indicator for screen-reader context */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {tabs[activeIndex]?.label} tab selected
      </p>
    </div>
  );
}
