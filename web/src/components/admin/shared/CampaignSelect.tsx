"use client";

// M07 — Campaign combobox/select populated from GET /api/admin/campaigns.
// Phase 1: loads up to 200 campaigns (documented limitation).

import * as React from "react";
import { apiFetch } from "@/lib/api";

interface Campaign {
  id: string;
  name: string;
}

interface CampaignSelectProps {
  value: string; // '' = global, '__SYS__' for status global, or a campaign ID
  onChange: (value: string) => void;
  allowGlobal?: boolean;
  globalLabel?: string;
  disabled?: boolean;
  id?: string;
  required?: boolean;
}

export function CampaignSelect({
  value,
  onChange,
  allowGlobal = true,
  globalLabel = "All campaigns (global)",
  disabled = false,
  id,
  required,
}: CampaignSelectProps): React.ReactElement {
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    apiFetch<{ data: Campaign[] }>("/api/admin/campaigns?active=true&pageSize=200")
      .then((res) => setCampaigns(res.data))
      .catch(() => {/* silently fail — show empty list */})
      .finally(() => setLoading(false));
  }, []);

  return (
    <select
      id={id}
      value={value}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      disabled={disabled || loading}
      required={required}
      className={[
        "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]",
        "px-3 py-2 text-sm text-[var(--color-fg)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
        disabled ? "opacity-60 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {allowGlobal && (
        <option value="">{loading ? "Loading campaigns..." : globalLabel}</option>
      )}
      {campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.id})
        </option>
      ))}
    </select>
  );
}
