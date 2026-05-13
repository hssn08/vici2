"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { BlockReason } from "@/lib/stores/dial";

const CODE_LABELS: Partial<Record<string, string>> = {
  TCPA_BLOCKED: "Outside calling window",
  DNC_BLOCKED: "Federal DNC list",
  CONSENT_BLOCKED: "Consent required",
  GATEWAY_LIMIT: "Carrier at capacity",
  CARRIER_FAIL: "Carrier error",
  AGENT_DIAL_LOCK: "Another tab is dialing",
  AGENT_NOT_READY: "Agent not ready",
  CALL_FAILED: "Call failed",
  INVALID_PHONE: "Invalid phone number",
  CAMPAIGN_PAUSED: "Campaign paused",
  COUNTRY_NOT_ALLOWED: "Country not allowed",
  PENDING_DISPO: "Complete your last call first",
};

export interface BlockedScreenProps {
  reason: BlockReason;
  hasLead: boolean;
  onDismiss: () => void;
  onTryAgain?: () => void;
}

export function BlockedScreen({
  reason,
  hasLead,
  onDismiss,
  onTryAgain,
}: BlockedScreenProps): React.ReactElement {
  const label = CODE_LABELS[reason.code] ?? reason.code;
  const isRetryable =
    reason.code === "GATEWAY_LIMIT" ||
    reason.code === "CARRIER_FAIL" ||
    reason.code === "CALL_FAILED";

  // Auto-retry for GATEWAY_LIMIT after retryAfter seconds
  const [countdown, setCountdown] = React.useState<number | null>(
    reason.code === "GATEWAY_LIMIT" && reason.retryAfter
      ? reason.retryAfter
      : null,
  );

  React.useEffect(() => {
    if (countdown === null || countdown <= 0) {
      if (countdown === 0 && onTryAgain) onTryAgain();
      return;
    }
    const id = setInterval(
      () => setCountdown((c) => (c !== null ? c - 1 : null)),
      1000,
    );
    return () => clearInterval(id);
  }, [countdown, onTryAgain]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-[var(--radius-card)] border border-[var(--color-state-error)] bg-red-50 p-6 space-y-4"
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden>
          🚫
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[var(--color-state-error)]">
            {label}
          </p>
          <p className="text-sm text-[var(--color-fg-muted)] mt-1">
            {reason.message}
          </p>
          {reason.code === "DNC_BLOCKED" && (
            <p className="text-xs text-[var(--color-fg-muted)] mt-2">
              Contact your supervisor to request a bypass.
            </p>
          )}
          {reason.code === "AGENT_DIAL_LOCK" && (
            <p className="text-xs text-[var(--color-fg-muted)] mt-2">
              Another browser tab is dialing. Switch to that tab.
            </p>
          )}
          {countdown !== null && countdown > 0 && (
            <p className="text-xs text-amber-700 mt-2">
              Auto-retry in {countdown}s…
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-3 justify-end">
        <Button variant="secondary" onClick={onDismiss}>
          Dismiss
        </Button>
        {isRetryable && onTryAgain && (
          <Button variant="primary" onClick={onTryAgain}>
            {hasLead ? "Try again" : "Try another lead"}
          </Button>
        )}
      </div>
    </div>
  );
}
