"use client";

// useMonitorSession — React hook for the supervisor's active monitor session.
//
// Lifecycle:
//   1. start(targetUid, mode) → POST /api/sup/monitor/start → receive token +
//      dial_extension → SIP.js INVITE with X-Vici2-Monitor-Token header.
//   2. switchMode(newMode) → PATCH /api/sup/sessions/:id/mode.
//   3. end() → DELETE /api/sup/sessions/:id + SIP.js BYE.
//
// S02 PLAN §9.1, §15.4.

import { useState, useCallback, useRef } from "react";
import type { MonitorMode, MonitorStartResponse, MonitorModeSwitchResponse } from "@vici2/types";

export type MonitorSessionState =
  | { status: "idle" }
  | { status: "starting"; targetUid: number; mode: MonitorMode }
  | {
      status: "active";
      sessionId: string;
      targetUid: number;
      mode: MonitorMode;
      startedAt: Date;
      dialExtension: string;
    }
  | { status: "ending"; sessionId: string }
  | { status: "ended"; reason: string };

interface UseMonitorSessionResult {
  session: MonitorSessionState;
  start: (targetUid: number, mode: MonitorMode) => Promise<void>;
  switchMode: (newMode: MonitorMode) => Promise<void>;
  end: () => Promise<void>;
  error: string | null;
}

export function useMonitorSession(): UseMonitorSessionResult {
  const [session, setSession] = useState<MonitorSessionState>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  const start = useCallback(async (targetUid: number, mode: MonitorMode) => {
    setError(null);
    setSession({ status: "starting", targetUid, mode });

    try {
      // Step 1: Pre-flight API call.
      const resp = await fetch("/api/sup/monitor/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_uid: targetUid, initial_mode: mode }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "unknown" })) as { error?: string };
        const code = (body as { error?: string }).error ?? "unknown";
        setError(errorMessage(code, resp.status));
        setSession({ status: "idle" });
        return;
      }

      const data = await resp.json() as MonitorStartResponse;

      // Step 2: SIP.js INVITE with X-Vici2-Monitor-Token header.
      // Phase 1: delegate to the global SIP.js SimpleUser exposed by the
      // supervisor softphone. The actual SIP.js integration is in A02.
      if (typeof window !== "undefined" && "vici2Sip" in window) {
        const sip = (window as Window & { vici2Sip?: { call: (ext: string, extraHeaders?: string[]) => Promise<void> } }).vici2Sip;
        if (sip) {
          await sip.call(data.dial_extension, [
            `X-Vici2-Monitor-Token: ${data.token}`,
          ]);
        }
      }

      activeSessionIdRef.current = data.session_id;
      setSession({
        status: "active",
        sessionId: data.session_id,
        targetUid,
        mode,
        startedAt: new Date(),
        dialExtension: data.dial_extension,
      });
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
      setSession({ status: "idle" });
    }
  }, []);

  const switchMode = useCallback(async (newMode: MonitorMode) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || session.status !== "active") {
      setError("No active session to switch mode");
      return;
    }
    if (session.mode === newMode) return;

    setError(null);

    try {
      const resp = await fetch(`/api/sup/sessions/${sessionId}/mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "unknown" })) as { error?: string };
        const code = (body as { error?: string }).error ?? "unknown";
        if (resp.status === 429) {
          setError("Too many mode switches. Please wait a moment.");
        } else {
          setError(errorMessage(code, resp.status));
        }
        return;
      }

      const data = await resp.json() as MonitorModeSwitchResponse;
      setSession((prev) =>
        prev.status === "active" ? { ...prev, mode: data.mode as MonitorMode } : prev,
      );
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    }
  }, [session]);

  const end = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    setSession({ status: "ending", sessionId });

    try {
      await fetch(`/api/sup/sessions/${sessionId}`, { method: "DELETE" });
    } catch {
      // Even if the API call fails, we consider the session ended locally.
    }

    // Send SIP BYE via global SIP.js instance.
    if (typeof window !== "undefined" && "vici2Sip" in window) {
      const sip = (window as Window & { vici2Sip?: { hangup: () => void } }).vici2Sip;
      sip?.hangup?.();
    }

    activeSessionIdRef.current = null;
    setSession({ status: "ended", reason: "supervisor_ended" });
  }, []);

  return { session, start, switchMode, end, error };
}

function errorMessage(code: string, status: number): string {
  switch (code) {
    case "agent_not_found": return "Agent not found.";
    case "agent_not_in_call": return "Agent is not currently on a call.";
    case "agent_consent_missing": return "Agent has not acknowledged monitoring consent. Ask them to re-login.";
    case "member_budget_exceeded": return "Conference is full. Try again later.";
    case "tenant_mismatch": return "Cannot monitor agents in a different tenant.";
    case "role_insufficient": return "Your role does not permit monitoring.";
    case "rate_limited": return "Mode switch rate limit exceeded. Wait one second.";
    default: return `Error ${status}: ${code}`;
  }
}
