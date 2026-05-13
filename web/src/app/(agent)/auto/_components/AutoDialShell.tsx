"use client";

/**
 * AutoDialShell — outer container for the /auto page.
 *
 * Owns:
 *  - 7-state discriminated-union state machine (useReducer)
 *  - WS subscriptions (call.reserved, call.failed, call.reservation_expired,
 *    call.disposed, agent.state_changed, campaign.config_changed)
 *  - Audio pre-arm on first user interaction
 *  - BroadcastChannel multi-tab guard
 *  - Reservation timeout (client-side dual enforcement)
 *  - Hotkey registration (auto-dial scope)
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { createReconnectingWs } from "@/lib/ws";
import { useAuthStore } from "@/lib/stores/auth";
import { useAgentStore } from "@/lib/stores/agent";
import { useCallStore, type LeadSnapshot, type CampaignConfig } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";
import { useHotkeys } from "@/lib/hotkeys/useHotkeys";
import { api, ApiError } from "@/lib/api";
import { getWsUrl } from "@/lib/env";
import { audioManager } from "./AudioManager";
import { WaitingScreen } from "./WaitingScreen";
import { ReservationOverlay } from "./ReservationOverlay";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReservationData {
  callUuid: string;
  attemptUuid: string;
  lead: LeadSnapshot;
  campaignId: number;
  campaignName: string;
  scriptSnippet: string | null;
}

/** Discriminated-union state machine */
export type AutoDialStatus =
  | "idle"
  | "reserved"
  | "calling"
  | "connected"
  | "wrapup"
  | "missed"
  | "paused";

export type AutoDialState =
  | { status: "idle" }
  | { status: "reserved"; reservation: ReservationData; startedAt: string }
  | { status: "calling" }
  | { status: "connected" }
  | { status: "wrapup" }
  | { status: "missed" }
  | { status: "paused" };

export type AutoDialAction =
  | { type: "RESERVATION_RECEIVED"; data: ReservationData; startedAt: string }
  | { type: "CALL_BRIDGED" }
  | { type: "CALL_FAILED"; reason: string }
  | { type: "CALL_HANGUP" }
  | { type: "RESERVATION_EXPIRED" }
  | { type: "RESERVATION_TIMEOUT" }
  | { type: "AGENT_SKIP" }
  | { type: "AGENT_ACCEPT" }
  | { type: "DISPO_SUBMITTED" }
  | { type: "PAUSE_QUEUED" }
  | { type: "PAUSE_READY" }
  | { type: "SIP_NOT_READY" }
  | { type: "RETURN_TO_AUTODIAL" }
  | { type: "DISMISS_MISSED" };

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function autoDialReducer(
  state: AutoDialState,
  action: AutoDialAction,
): AutoDialState {
  switch (action.type) {
    case "RESERVATION_RECEIVED":
      if (state.status !== "idle" && state.status !== "paused") return state;
      return {
        status: "reserved",
        reservation: action.data,
        startedAt: action.startedAt,
      };

    case "CALL_BRIDGED":
      if (state.status === "reserved" || state.status === "calling") {
        return { status: "calling" };
      }
      return state;

    case "CALL_FAILED":
      if (state.status === "reserved" || state.status === "calling") {
        return { status: "idle" };
      }
      return state;

    case "CALL_HANGUP":
      if (state.status === "calling" || state.status === "connected") {
        return { status: "wrapup" };
      }
      return state;

    case "RESERVATION_EXPIRED":
    case "RESERVATION_TIMEOUT":
      if (state.status === "reserved") {
        return { status: "missed" };
      }
      return state;

    case "AGENT_SKIP":
      if (state.status === "reserved") {
        return { status: "idle" };
      }
      return state;

    case "AGENT_ACCEPT":
      if (state.status === "reserved") {
        return { status: "reserved", reservation: (state as Extract<AutoDialState, { status: "reserved" }>).reservation, startedAt: (state as Extract<AutoDialState, { status: "reserved" }>).startedAt };
      }
      return state;

    case "DISPO_SUBMITTED":
      if (state.status === "wrapup") {
        return { status: "idle" };
      }
      return state;

    case "PAUSE_QUEUED":
      if (state.status === "idle") return { status: "paused" };
      return state;

    case "PAUSE_READY":
      if (state.status === "paused") return { status: "idle" };
      return state;

    case "SIP_NOT_READY":
      if (state.status === "reserved") return { status: "idle" };
      return state;

    case "RETURN_TO_AUTODIAL":
      if (state.status === "paused" || state.status === "missed") {
        return { status: "idle" };
      }
      return state;

    case "DISMISS_MISSED":
      if (state.status === "missed") return { status: "paused" };
      return state;

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RESERVATION_TIMEOUT_MS = 10_000; // 10 s (matches server default)
const AUTO_DIAL_CHANNEL = "vici2-auto-dial";

export function AutoDialShell(): React.ReactElement {
  const router = useRouter();
  const wsToken = useAuthStore((s) => s.wsToken);
  const agentStatus = useAgentStore((s) => s.status);
  const callStore = useCallStore;

  const setReservation = useCallStore((s) => s.setReservation);
  const clearReservation = useCallStore((s) => s.clearReservation);
  const incrementMissed = useCallStore((s) => s.incrementMissedReservations);
  const campaign = useCallStore((s) => s.campaign);
  const dialMode = useCallStore((s) => s.dialMode);
  const previewExpiresAt = useCallStore((s) => s.previewExpiresAt);

  const chimeMuted = useUiStore((s) => s.autoDialChimeMuted);
  const chimeVolume = useUiStore((s) => s.autoDialChimeVolume);
  const setChimeMuted = useUiStore((s) => s.setAutoDialChimeMuted);

  const [state, dispatch] = React.useReducer(autoDialReducer, { status: "idle" });

  // Sync chime volume
  React.useEffect(() => {
    audioManager.setVolume(chimeVolume);
    audioManager.setMuted(chimeMuted);
  }, [chimeVolume, chimeMuted]);

  // Pre-arm audio on first user interaction
  React.useEffect(() => {
    const arm = async () => {
      if (!audioManager.isArmed()) {
        await audioManager.arm("/sounds/reservation-chime.wav");
      }
    };
    document.addEventListener("click", arm, { once: true });
    document.addEventListener("keydown", arm, { once: true });
    return () => {
      document.removeEventListener("click", arm);
      document.removeEventListener("keydown", arm);
    };
  }, []);

  // Sync from useCallStore.phase (A05 owns CALLING/CONNECTED/WRAPUP transitions)
  React.useEffect(() => {
    const unsub = callStore.subscribe(
      (s) => s.phase,
      (phase) => {
        if (phase === "active") dispatch({ type: "CALL_BRIDGED" });
        if (phase === "wrapup") dispatch({ type: "CALL_HANGUP" });
      },
    );
    return unsub;
  }, [callStore]);

  // Reservation timeout timer
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReservationTimeout = React.useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (state.status === "reserved") {
      clearReservationTimeout();
      timeoutRef.current = setTimeout(async () => {
        const reservedState = state as Extract<AutoDialState, { status: "reserved" }>;
        dispatch({ type: "RESERVATION_TIMEOUT" });
        incrementMissed();
        clearReservation();
        try {
          await api.post("/api/agent/reservation/reject", {
            call_uuid: reservedState.reservation.callUuid,
            reason: "client_timeout",
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Already bridged — navigate to call
            router.push("/call");
          }
        }
      }, RESERVATION_TIMEOUT_MS);
    } else {
      clearReservationTimeout();
    }
    return clearReservationTimeout;
  }, [state, incrementMissed, clearReservation, clearReservationTimeout, router]);

  // Navigate to /call when state becomes 'calling'
  React.useEffect(() => {
    if (state.status === "calling") {
      router.push("/call");
    }
  }, [state.status, router]);

  // Update document title for visual notification
  React.useEffect(() => {
    if (state.status === "reserved") {
      const name = (state as Extract<AutoDialState, { status: "reserved" }>).reservation.campaignName;
      document.title = `Incoming Call — ${name}`;
    } else {
      document.title = "Auto-Dial — vici2";
    }
    return () => {
      document.title = "vici2";
    };
  }, [state]);

  // BroadcastChannel multi-tab guard
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(AUTO_DIAL_CHANNEL);
    bc.onmessage = (e: MessageEvent<{ event: string; call_uuid?: string }>) => {
      if (e.data.event === "reservation-received") {
        // Another tab received the reservation — show informational banner
        // (we don't handle the call here)
      }
    };
    return () => bc.close();
  }, []);

  // WS subscriptions
  React.useEffect(() => {
    if (!wsToken) return;

    const ws = createReconnectingWs({
      url: () => getWsUrl(),
      token: () => useAuthStore.getState().wsToken,
    });

    const unsubs = [
      ws.subscribe("call.reserved", async (event) => {
        const data = event.data as {
          call_uuid: string;
          attempt_uuid: string;
          lead: LeadSnapshot;
          campaign: CampaignConfig;
          campaign_id: number;
          campaign_name: string;
          script_snippet: string | null;
          reservation_expires_at: string;
          preview_expires_at: string | null;
          dial_mode: "progressive" | "predictive";
        };

        const reservationData: ReservationData = {
          callUuid: data.call_uuid,
          attemptUuid: data.attempt_uuid,
          lead: data.lead,
          campaignId: data.campaign_id,
          campaignName: data.campaign_name ?? data.campaign?.name ?? "Unknown",
          scriptSnippet: data.script_snippet ?? null,
        };

        const now = new Date().toISOString();

        setReservation({
          callUuid: data.call_uuid,
          attemptUuid: data.attempt_uuid,
          lead: data.lead,
          campaign: data.campaign,
          reservationExpiresAt: data.reservation_expires_at ?? new Date(Date.now() + RESERVATION_TIMEOUT_MS).toISOString(),
          previewExpiresAt: data.preview_expires_at ?? null,
          dialMode: data.dial_mode ?? "progressive",
        });

        dispatch({
          type: "RESERVATION_RECEIVED",
          data: reservationData,
          startedAt: now,
        });

        await audioManager.play();

        // BroadcastChannel: notify other tabs
        if (typeof BroadcastChannel !== "undefined") {
          const bc = new BroadcastChannel(AUTO_DIAL_CHANNEL);
          bc.postMessage({ event: "reservation-received", call_uuid: data.call_uuid });
          bc.close();
        }
      }),

      ws.subscribe("call.failed", (event) => {
        const data = event.data as { reason: string };
        dispatch({ type: "CALL_FAILED", reason: data.reason ?? "Call failed" });
        clearReservation();
      }),

      ws.subscribe("call.reservation_expired", () => {
        dispatch({ type: "RESERVATION_EXPIRED" });
        incrementMissed();
        clearReservation();
      }),

      ws.subscribe("call.disposed", () => {
        dispatch({ type: "DISPO_SUBMITTED" });
      }),

      ws.subscribe("agent.state_changed", (event) => {
        const data = event.data as { user_id: string; status: string };
        const myId = useAuthStore.getState().user?.id;
        if (data.user_id === myId) {
          useAgentStore.getState().setStatus(data.status as import("@/lib/stores/agent").AgentStatus);
        }
      }),
    ];

    ws.start();

    return () => {
      unsubs.forEach((fn) => fn());
      ws.stop();
    };
  }, [wsToken, setReservation, clearReservation, incrementMissed]);

  // Hotkeys
  const reservedState = state.status === "reserved"
    ? (state as Extract<AutoDialState, { status: "reserved" }>)
    : null;

  const handleSkip = React.useCallback(async () => {
    if (!reservedState) return;
    dispatch({ type: "AGENT_SKIP" });
    clearReservation();
    try {
      await api.post("/api/agent/reservation/reject", {
        call_uuid: reservedState.reservation.callUuid,
        reason: "agent_skip",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        router.push("/call");
      }
    }
  }, [reservedState, clearReservation, router]);

  const handleAccept = React.useCallback(async () => {
    if (!reservedState || !previewExpiresAt) return;
    dispatch({ type: "AGENT_ACCEPT" });
    try {
      await api.post("/api/agent/reservation/accept", {
        call_uuid: reservedState.reservation.callUuid,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        router.push("/call");
      }
    }
  }, [reservedState, previewExpiresAt, router]);

  const handleReturnToAutoDial = React.useCallback(async () => {
    dispatch({ type: "RETURN_TO_AUTODIAL" });
    try {
      await api.post("/api/agent/state", { status: "ready" });
    } catch {
      // Best-effort
    }
  }, []);

  const handleDismissMissed = React.useCallback(() => {
    dispatch({ type: "DISMISS_MISSED" });
  }, []);

  useHotkeys(
    React.useMemo(
      () => [
        {
          scope: "auto-dial" as const,
          key: "Escape",
          ignoreInputFocus: false,
          handler: () => {
            if (state.status === "reserved") handleSkip();
          },
          description: "Reject reservation",
        },
        {
          scope: "auto-dial" as const,
          key: " ",
          ignoreInputFocus: false,
          handler: () => {
            if (state.status === "reserved" && previewExpiresAt) handleAccept();
          },
          description: "Accept call early (preview mode)",
        },
        {
          scope: "auto-dial" as const,
          key: "m",
          ignoreInputFocus: false,
          handler: () => {
            setChimeMuted(!chimeMuted);
            audioManager.setMuted(!chimeMuted);
          },
          description: "Toggle chime mute",
        },
      ],
      [state.status, previewExpiresAt, handleSkip, handleAccept, chimeMuted, setChimeMuted],
    ),
  );

  // Determine dial mode label for overlay
  const overlayDialMode: "PROGRESSIVE" | "PREDICTIVE" =
    dialMode === "predictive" ? "PREDICTIVE" : "PROGRESSIVE";

  const missedCount = useCallStore.getState().missedReservationsCount;

  return (
    <div className="relative min-h-[60vh]">
      <WaitingScreen
        status={state.status === "idle" || state.status === "reserved"
          ? "idle"
          : state.status === "missed"
            ? "missed"
            : "paused"}
        campaignName={campaign?.name ?? null}
        agentStatus={agentStatus}
        missedCount={missedCount}
        onReturnToAutoDial={handleReturnToAutoDial}
        onDismissMissed={handleDismissMissed}
      />

      {state.status === "reserved" && reservedState && (
        <ReservationOverlay
          reservation={reservedState.reservation}
          dialMode={overlayDialMode}
          previewExpiresAt={previewExpiresAt}
          reservationExpiresAt={useCallStore.getState().reservationExpiresAt ?? new Date(Date.now() + RESERVATION_TIMEOUT_MS).toISOString()}
          reservationStartedAt={reservedState.startedAt}
          onSkip={handleSkip}
          onAccept={handleAccept}
          onScheduleCallback={() => {
            // D06 callback modal — Phase 2 integration point
          }}
          visible
        />
      )}
    </div>
  );
}
