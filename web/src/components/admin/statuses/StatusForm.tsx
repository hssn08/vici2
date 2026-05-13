"use client";

// M07 — Status create/edit form (sub-page based).

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CampaignSelect } from "../shared/CampaignSelect";
import { StatusHotkeyInput } from "./StatusHotkeyInput";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusResponse {
  tenantId: string;
  campaignId: string;
  status: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  recycleDelaySeconds: number | null;
  category: string | null;
  systemOwner: string | null;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  { value: "", label: "— None —" },
  { value: "sale", label: "Sale" },
  { value: "not_interested", label: "Not interested" },
  { value: "dnc", label: "DNC" },
  { value: "callback", label: "Callback" },
  { value: "machine", label: "Machine" },
  { value: "system", label: "System" },
  { value: "other", label: "Other" },
];

// ---------------------------------------------------------------------------
// RecycleDelayInput
// ---------------------------------------------------------------------------

type RecycleMode = "null" | "immediate" | "terminal" | "custom";

interface RecycleDelayInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}

function RecycleDelayInput({ value, onChange, disabled }: RecycleDelayInputProps): React.ReactElement {
  const getMode = (v: number | null): RecycleMode => {
    if (v === null) return "null";
    if (v === 0) return "immediate";
    if (v === -1) return "terminal";
    return "custom";
  };

  const [mode, setMode] = React.useState<RecycleMode>(getMode(value));
  const [customSecs, setCustomSecs] = React.useState<string>(
    value !== null && value > 0 ? String(value) : "",
  );

  function handleModeChange(m: RecycleMode) {
    setMode(m);
    if (m === "null") onChange(null);
    else if (m === "immediate") onChange(0);
    else if (m === "terminal") onChange(-1);
    else {
      const n = parseInt(customSecs, 10);
      onChange(isNaN(n) ? null : n);
    }
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomSecs(e.target.value);
    const n = parseInt(e.target.value, 10);
    onChange(isNaN(n) ? null : n);
  }

  return (
    <div className="space-y-2">
      {(["null", "immediate", "terminal", "custom"] as RecycleMode[]).map((m) => (
        <label key={m} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="recycle-delay"
            value={m}
            checked={mode === m}
            onChange={() => handleModeChange(m)}
            disabled={disabled}
            className="accent-[var(--color-brand-600)]"
          />
          {m === "null" && "Campaign default (NULL)"}
          {m === "immediate" && "Immediate (0)"}
          {m === "terminal" && "Terminal — never recycle (-1)"}
          {m === "custom" && "Custom (seconds)"}
        </label>
      ))}
      {mode === "custom" && (
        <div className="pl-6">
          <Input
            type="number"
            value={customSecs}
            onChange={handleCustomChange}
            min={1}
            max={86400}
            placeholder="e.g. 3600"
            className="w-32"
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">1–86400 seconds (max 24 hours)</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StatusFormProps {
  mode: "create" | "edit";
  /** For edit: prefetched data from URL query params (campaignId + code). */
  prefillCampaignId?: string;
  prefillCode?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusForm({ mode, prefillCampaignId, prefillCode }: StatusFormProps): React.ReactElement {
  const isEdit = mode === "edit";

  // Form fields
  const [statusCode, setStatusCode] = React.useState(prefillCode ?? "");
  const [description, setDescription] = React.useState("");
  const [campaignId, setCampaignId] = React.useState(prefillCampaignId ?? "");
  const [category, setCategory] = React.useState("");
  const [selectable, setSelectable] = React.useState(true);
  const [humanAnswered, setHumanAnswered] = React.useState(false);
  const [sale, setSale] = React.useState(false);
  const [dnc, setDnc] = React.useState(false);
  const [callback, setCallback] = React.useState(false);
  const [notInterested, setNotInterested] = React.useState(false);
  const [hotkey, setHotkey] = React.useState("");
  const [recycleDelaySeconds, setRecycleDelaySeconds] = React.useState<number | null>(null);
  const [systemOwner, setSystemOwner] = React.useState<string | null>(null);

  const [loading, setLoading] = React.useState(isEdit);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  // Load existing status in edit mode
  React.useEffect(() => {
    if (!isEdit || !prefillCampaignId || !prefillCode) {
      setLoading(false);
      return;
    }
    apiFetch<StatusResponse>(
      `/api/admin/statuses/${encodeURIComponent(prefillCampaignId)}/${encodeURIComponent(prefillCode)}`,
    )
      .then((data) => {
        setStatusCode(data.status);
        setDescription(data.description);
        setCampaignId(data.campaignId);
        setCategory(data.category ?? "");
        setSelectable(data.selectable);
        setHumanAnswered(data.humanAnswered);
        setSale(data.sale);
        setDnc(data.dnc);
        setCallback(data.callback);
        setNotInterested(data.notInterested);
        setHotkey(data.hotkey ?? "");
        setRecycleDelaySeconds(data.recycleDelaySeconds);
        setSystemOwner(data.systemOwner);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to load status");
      })
      .finally(() => setLoading(false));
  }, [isEdit, prefillCampaignId, prefillCode]);

  const isSystemOwned = !!systemOwner;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    const body = {
      ...(mode === "create" && { status: statusCode, campaignId }),
      description,
      category: category || null,
      selectable,
      humanAnswered,
      sale,
      dnc,
      callback,
      notInterested,
      hotkey: hotkey || null,
      recycleDelaySeconds,
    };

    try {
      if (mode === "create") {
        await apiFetch<StatusResponse>("/api/admin/statuses", {
          method: "POST",
          body: { ...body, status: statusCode, campaignId },
        });
        window.location.href = "/admin/statuses";
      } else {
        await apiFetch<StatusResponse>(
          `/api/admin/statuses/${encodeURIComponent(prefillCampaignId!)}/${encodeURIComponent(prefillCode!)}`,
          { method: "PATCH", body },
        );
        setSuccess("Status saved.");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "hotkey_conflict") {
          setError(`Hotkey conflict: ${err.message}`);
        } else if (err.code === "status_exists") {
          setError("A status with this code already exists in this campaign scope.");
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

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={(e: React.FormEvent<HTMLFormElement>) => void handleSubmit(e)} className="space-y-6 max-w-2xl">
      {isSystemOwned && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-4">
          <p className="text-sm text-amber-800">
            This status is owned by system module <strong>{systemOwner}</strong>. It cannot be deleted.
            Some fields are read-only.
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Status Code */}
      <div className="space-y-1">
        <label htmlFor="st-code" className="text-sm font-medium text-[var(--color-fg)]">
          Status Code <span aria-hidden className="text-[var(--color-state-error)]">*</span>
          {isEdit && <span className="ml-2 text-xs text-[var(--color-fg-muted)]">(locked in edit)</span>}
        </label>
        <Input
          id="st-code"
          value={statusCode}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStatusCode(e.target.value.toUpperCase())}
          maxLength={24}
          required
          disabled={isEdit}
          placeholder="e.g. SALE"
          className="font-mono"
        />
      </div>

      {/* Description */}
      <div className="space-y-1">
        <label htmlFor="st-desc" className="text-sm font-medium text-[var(--color-fg)]">
          Description
        </label>
        <Input
          id="st-desc"
          value={description}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          maxLength={128}
          placeholder="e.g. Sale completed"
          disabled={isSystemOwned}
        />
      </div>

      {/* Campaign */}
      <div className="space-y-1">
        <label htmlFor="st-campaign" className="text-sm font-medium text-[var(--color-fg)]">
          Campaign <span aria-hidden className="text-[var(--color-state-error)]">*</span>
          {isEdit && <span className="ml-2 text-xs text-[var(--color-fg-muted)]">(locked in edit)</span>}
        </label>
        {isEdit ? (
          <Input value={campaignId === "__SYS__" ? "Global (__SYS__)" : campaignId} disabled className="bg-[var(--color-surface-muted)]" />
        ) : (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="campaign-scope"
                checked={campaignId === "__SYS__"}
                onChange={() => setCampaignId("__SYS__")}
                className="accent-[var(--color-brand-600)]"
              />
              Global (__SYS__)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="campaign-scope"
                checked={campaignId !== "__SYS__"}
                onChange={() => setCampaignId("")}
                className="accent-[var(--color-brand-600)]"
              />
              Per-campaign:
            </label>
            {campaignId !== "__SYS__" && (
              <div className="pl-6">
                <CampaignSelect
                  id="st-campaign"
                  value={campaignId}
                  onChange={setCampaignId}
                  allowGlobal={false}
                  required
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Category */}
      <div className="space-y-1">
        <label htmlFor="st-category" className="text-sm font-medium text-[var(--color-fg)]">Category</label>
        <select
          id="st-category"
          value={category}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCategory(e.target.value)}
          disabled={isSystemOwned}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Boolean flags */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {([
          { id: "st-selectable", label: "Selectable by agents", value: selectable, setter: setSelectable },
          { id: "st-ha", label: "Human answered", value: humanAnswered, setter: setHumanAnswered },
          { id: "st-sale", label: "Sale", value: sale, setter: setSale },
          { id: "st-dnc", label: "DNC", value: dnc, setter: setDnc },
          { id: "st-callback", label: "Callback", value: callback, setter: setCallback },
          { id: "st-ni", label: "Not interested", value: notInterested, setter: setNotInterested },
        ] as Array<{ id: string; label: string; value: boolean; setter: (v: boolean) => void }>).map(
          ({ id, label, value, setter }) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                checked={value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setter(e.target.checked)}
                disabled={isSystemOwned}
                className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-600)]"
              />
              {label}
            </label>
          ),
        )}
      </div>

      {/* Hotkey */}
      <div className="space-y-1">
        <label htmlFor="st-hotkey" className="text-sm font-medium text-[var(--color-fg)]">
          Hotkey <span className="text-[var(--color-fg-muted)]">(optional, single character)</span>
        </label>
        <StatusHotkeyInput
          id="st-hotkey"
          value={hotkey}
          onChange={setHotkey}
          campaignId={campaignId}
          excludeStatusCode={isEdit ? prefillCode : undefined}
          disabled={isSystemOwned}
        />
      </div>

      {/* Recycle delay */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--color-fg)]">Recycle delay</label>
        <RecycleDelayInput
          value={recycleDelaySeconds}
          onChange={setRecycleDelaySeconds}
          disabled={isSystemOwned}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={saving || !statusCode.trim() || (!isEdit && !campaignId.trim())}>
          {saving ? "Saving..." : mode === "create" ? "Create status" : "Save changes"}
        </Button>
        <a href="/admin/statuses" className="text-sm text-[var(--color-fg-muted)] hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
