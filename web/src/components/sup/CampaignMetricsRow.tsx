"use client";

// CampaignMetricsRow — horizontal scrolling row of CampaignCard tiles.
//
// S01 PLAN §5.

import React from "react";
import type { CampaignMetrics } from "@/lib/stores/dashboard.js";
import { CampaignCard } from "./CampaignCard.js";

export interface CampaignMetricsRowProps {
  campaigns: CampaignMetrics[];
}

export function CampaignMetricsRow({ campaigns }: CampaignMetricsRowProps): React.ReactElement {
  if (campaigns.length === 0) {
    return (
      <section aria-label="Campaign metrics">
        <p className="text-sm text-[var(--color-fg-muted)]">No active campaigns.</p>
      </section>
    );
  }

  return (
    <section aria-label="Campaign metrics">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--color-fg-muted)]">
        Campaigns
      </h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {campaigns.map((c) => (
          <CampaignCard key={c.campaignId} metrics={c} />
        ))}
      </div>
    </section>
  );
}
