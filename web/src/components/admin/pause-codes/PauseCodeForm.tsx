"use client";

// M07 — Pause code create/edit form.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CampaignSelect } from "../shared/CampaignSelect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PauseCodeResponse {
  id: string;
  tenantId: string;
  campaignId: string | null;
  code: string;
  name: string;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PauseCodeFormProps {
  editItem?: PauseCodeResponse | null;
  onSaved: (item: PauseCodeResponse) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PauseCodeForm({ editItem, onSaved, onCancel }: PauseCodeFormProps): React.ReactElement {
  const [code, setCode] = React.useState(editItem?.code ?? "");
  const [name, setName] = React.useState(editItem?.name ?? "");
  const [billable, setBillable] = React.useState(editItem?.billable ?? true);
  const [campaignId, setCampaignId] = React.useState(editItem?.campaignId ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isEdit = !!editItem;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body = {
      code: code.toUpperCase(),
      name,
      billable,
      campaignId: campaignId || null,
    };

    try {
      let result: PauseCodeResponse;
      if (isEdit) {
        result = await apiFetch<PauseCodeResponse>(`/api/admin/pause-codes/${editItem.id}`, {
          method: "PATCH",
          body,
        });
      } else {
        result = await apiFetch<PauseCodeResponse>("/api/admin/pause-codes", {
          method: "POST",
          body,
        });
      }
      onSaved(result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "conflict") {
          setError("A pause code with this code already exists in this scope.");
        } else {
          setError(err.message);
        }
      } else {
        setError("An unexpected error occurred.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e: React.FormEvent<HTMLFormElement>) => void handleSubmit(e)} className="space-y-4">
      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}

      {/* Code */}
      <div className="space-y-1">
        <label htmlFor="pc-code" className="text-sm font-medium text-[var(--color-fg)]">
          Code <span aria-hidden className="text-[var(--color-state-error)]">*</span>
        </label>
        <Input
          id="pc-code"
          value={code}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
          onBlur={() => setCode((c) => c.toUpperCase())}
          maxLength={16}
          required
          placeholder="e.g. BREAK"
          pattern="[A-Z0-9_\\-]{1,16}"
          className="font-mono uppercase"
        />
        <p className="text-xs text-[var(--color-fg-muted)]">
          1–16 uppercase alphanumeric, underscore, or hyphen.
        </p>
      </div>

      {/* Name */}
      <div className="space-y-1">
        <label htmlFor="pc-name" className="text-sm font-medium text-[var(--color-fg)]">
          Name <span aria-hidden className="text-[var(--color-state-error)]">*</span>
        </label>
        <Input
          id="pc-name"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          maxLength={64}
          required
          placeholder="e.g. Lunch break"
        />
      </div>

      {/* Billable */}
      <div className="flex items-center gap-3">
        <input
          id="pc-billable"
          type="checkbox"
          checked={billable}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBillable(e.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-600)]"
        />
        <label htmlFor="pc-billable" className="text-sm font-medium text-[var(--color-fg)]">
          Billable time
        </label>
      </div>

      {/* Campaign */}
      <div className="space-y-1">
        <label htmlFor="pc-campaign" className="text-sm font-medium text-[var(--color-fg)]">
          Campaign <span className="text-[var(--color-fg-muted)]">(optional — leave blank for global)</span>
        </label>
        <CampaignSelect
          id="pc-campaign"
          value={campaignId}
          onChange={setCampaignId}
          allowGlobal
          globalLabel="Global (all campaigns)"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={saving || !code.trim() || !name.trim()}>
          {saving ? "Saving..." : isEdit ? "Save changes" : "Create pause code"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
