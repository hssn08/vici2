"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PauseCodeOption } from "@/lib/agent/useAgentState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PauseCodeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "OPTIONAL" | "FORCE";
  codes: PauseCodeOption[];
  loading: boolean;
  error: string | null;
  lastUsedCode: string | null;
  onSelect: (code: string | null, freeText?: string | null) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// PauseCodeMenu
// ---------------------------------------------------------------------------

export function PauseCodeMenu({
  open,
  onOpenChange,
  mode,
  codes,
  loading,
  error,
  lastUsedCode,
  onSelect,
  onCancel,
}: PauseCodeMenuProps): React.ReactElement {
  const [selectedCode, setSelectedCode] = React.useState<string | null>(null);
  const [freeText, setFreeText] = React.useState("");
  const firstItemRef = React.useRef<HTMLButtonElement>(null);
  const freeTextRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  // Pre-select last-used code when menu opens
  React.useEffect(() => {
    if (open) {
      const validLastUsed =
        lastUsedCode && codes.some((c) => c.code === lastUsedCode)
          ? lastUsedCode
          : null;
      setSelectedCode(validLastUsed);
      setFreeText("");
    }
  }, [open, lastUsedCode, codes]);

  // Focus management on open
  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      if (mode === "OPTIONAL" && !selectedCode) {
        freeTextRef.current?.focus();
      } else {
        firstItemRef.current?.focus();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [open, mode, selectedCode]);

  // Keyboard navigation in list
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[role="option"]',
    );
    if (!items || items.length === 0) return;
    const focused = document.activeElement as HTMLButtonElement;
    const idx = Array.from(items).indexOf(focused);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(idx + 1, items.length - 1);
      items[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(idx - 1, 0);
      items[prev]?.focus();
    }
  };

  const handleConfirm = () => {
    onSelect(selectedCode, freeText.trim() || null);
  };

  const handleSkip = () => {
    onSelect(null, null);
  };

  const handleCancel = () => {
    onCancel();
    onOpenChange(false);
  };

  // Sort: last-used first, then alphabetical
  const sortedCodes = React.useMemo(() => {
    const copy = [...codes];
    copy.sort((a, b) => {
      if (a.code === lastUsedCode) return -1;
      if (b.code === lastUsedCode) return 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [codes, lastUsedCode]);

  const isForce = mode === "FORCE";
  const hasNoCodesAndForce = isForce && !loading && codes.length === 0;
  const canConfirm =
    !hasNoCodesAndForce &&
    (selectedCode !== null ||
      (!isForce && freeText.trim().length > 0));

  // ---- No codes in FORCE mode ----
  if (hasNoCodesAndForce) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle id="pause-menu-title">Cannot Pause</DialogTitle>
          </DialogHeader>
          <div role="alert" className="text-sm text-[var(--color-fg-muted)]">
            No pause codes are configured for this campaign. Please contact
            your administrator.
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" onClick={handleCancel}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-labelledby="pause-menu-title">
        <DialogHeader>
          <DialogTitle id="pause-menu-title">
            {isForce
              ? "Select pause reason (required)"
              : "Why are you pausing?"}
          </DialogTitle>
          {!isForce && (
            <DialogDescription>
              Select a code, type a reason, or skip.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Code list */}
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Pause codes"
            aria-required={isForce}
            className="max-h-48 overflow-y-auto rounded-md border divide-y divide-[var(--color-surface-border)]"
            onKeyDown={handleListKeyDown}
          >
            {sortedCodes.map((code, idx) => {
              const isSelected = selectedCode === code.code;
              const isRecent = code.code === lastUsedCode;
              return (
                <li key={code.code} role="presentation">
                  <button
                    ref={idx === 0 ? firstItemRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors focus:outline-none focus-visible:ring-2",
                      isSelected
                        ? "bg-[var(--color-brand-600)]/10 font-medium"
                        : "hover:bg-[var(--color-surface-muted)]",
                    )}
                    onClick={() =>
                      setSelectedCode(isSelected ? null : code.code)
                    }
                  >
                    <span className="flex-1">{code.name}</span>
                    {isRecent && (
                      <Badge tone="neutral" className="text-xs">
                        Recent
                      </Badge>
                    )}
                    {code.billable && (
                      <span className="text-xs text-[var(--color-fg-muted)]">
                        billable
                      </span>
                    )}
                    {isSelected && (
                      <span aria-hidden className="ml-1 text-[var(--color-brand-600)]">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Free-text (OPTIONAL only) */}
        {!isForce && (
          <div className="mt-3">
            <label
              htmlFor="pause-reason-input"
              className="mb-1 block text-xs text-[var(--color-fg-muted)]"
            >
              Or enter a reason:
            </label>
            <Input
              ref={freeTextRef}
              id="pause-reason-input"
              placeholder="Type reason…"
              maxLength={255}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  handleConfirm();
                }
              }}
            />
          </div>
        )}

        {/* Error */}
        {error && (
          <p role="alert" className="mt-2 text-xs text-[var(--color-state-error)]">
            {error}
          </p>
        )}

        {/* Footer */}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          {!isForce && (
            <Button variant="ghost" onClick={handleSkip}>
              Skip
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            onClick={handleConfirm}
          >
            Pause
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
