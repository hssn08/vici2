"use client";

/**
 * web/src/components/recordings/LegalHoldToggle.tsx
 *
 * Legal hold toggle — visible only to super_admin.
 * Calls POST/DELETE /api/recordings/:id/legal-hold (R02 routes).
 * Optimistic update with rollback on error.
 * R03 PLAN §3.4.
 */

import * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

interface LegalHoldToggleProps {
  recordingId: string;
  initialHeld: boolean;
  initialReason: string | null;
}

export function LegalHoldToggle({ recordingId, initialHeld, initialReason }: LegalHoldToggleProps): React.ReactElement {
  const [held, setHeld] = useState(initialHeld);
  const [reason, setReason] = useState(initialReason ?? "");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    const nextHeld = !held;
    setIsLoading(true);
    setError(null);

    // Optimistic
    setHeld(nextHeld);

    try {
      const method = nextHeld ? "POST" : "DELETE";
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/recordings/${recordingId}/legal-hold`,
        {
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: nextHeld && reason ? JSON.stringify({ reason }) : undefined,
        },
      );

      if (!res.ok && res.status !== 204) {
        // Rollback
        setHeld(!nextHeld);
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setHeld(!nextHeld);
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-amber-900">Legal hold</p>
          <p className="text-xs text-amber-700">
            {held
              ? "This recording is under legal hold and cannot be deleted or archived."
              : "Apply legal hold to prevent deletion and archive expiry."}
          </p>
        </div>
        <Button
          variant={held ? "destructive" : "primary"}
          size="sm"
          onClick={() => void toggle()}
          disabled={isLoading}
        >
          {isLoading ? "…" : held ? "Release hold" : "Apply hold"}
        </Button>
      </div>

      {!held && (
        <div>
          <label className="text-xs text-amber-700 block mb-1">Reason (optional)</label>
          <textarea
            className="w-full rounded border border-amber-200 bg-white px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-amber-400"
            placeholder="Case number, matter reference, etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}

      {held && initialReason && (
        <p className="text-xs text-amber-700">
          <strong>Reason:</strong> {initialReason}
        </p>
      )}

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
