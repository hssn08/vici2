"use client";

/**
 * A02 — SipProvider
 *
 * React context provider that manages the SIP.js SimpleUser lifecycle:
 *   1. Reads sipCreds from useAuthStore (F05 login response)
 *   2. Acquires microphone via getUserMedia
 *   3. Creates SimpleUser → connect() → register() → call(parkExt)
 *   4. Tears down (bye → unregister → disconnect) on logout / unmount
 *
 * Exposes SoftphoneContext consumed by useSoftphone().
 */

import * as React from "react";
import { Web } from "sip.js";
import { useAuthStore } from "@/lib/stores/auth";
import { useCallStore } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";
import { createSimpleUser } from "./createSimpleUser";
import { parkExtFor } from "./parkExt";
import {
  enumerateAudioDevices,
  queryMicPermission,
  setSpeakerDevice,
  replaceAudioTrack,
  acquireMic,
} from "./audio";
import { sendDtmf } from "./dtmf";
import {
  startStatsPoller,
  resetStatsCounters,
} from "./stats";
import { ReconnectManager } from "./reconnect";
import { AudioElement } from "./audioElement";
import { MicPermissionGate } from "./deviceUx/MicPermissionGate";
import type {
  SoftphoneContextValue,
  SoftphoneStatus,
  SoftphoneError,
  SoftphoneStats,
} from "./types";

// --------------------------------------------------------------------------
// Context
// --------------------------------------------------------------------------

const SoftphoneContext = React.createContext<SoftphoneContextValue | null>(
  null,
);
SoftphoneContext.displayName = "SoftphoneContext";

export { SoftphoneContext };

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

const TEARDOWN_DEADLINE_MS = 3000;

export function SipProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  // Auth
  const sipCreds = useAuthStore((s) => s.sipCreds);
  const user = useAuthStore((s) => s.user);

  // UI prefs
  const preferredMicId = useUiStore((s) => s.preferredMicId);
  const preferredSpeakerId = useUiStore((s) => s.preferredSpeakerId);
  const volume = useUiStore((s) => s.volume);
  const dtmfMode = useUiStore((s) => s.dtmfMode);
  const forceTurn = useUiStore((s) => s.forceTurn);
  const statsIntervalMs = useUiStore((s) => s.statsIntervalMs);
  const setVolume = useUiStore((s) => s.setVolume);

  // Call store
  const callSetPhase = useCallStore((s) => s.setPhase);
  const callToggleMute = useCallStore((s) => s.toggleMute);
  const callMuted = useCallStore((s) => s.muted);

  // Local state
  const [status, setStatus] = React.useState<SoftphoneStatus>("idle");
  const [error, setError] = React.useState<SoftphoneError | null>(null);
  const [onHold, setOnHold] = React.useState(false);
  const [micPermission, setMicPermission] = React.useState<
    "unknown" | "granted" | "denied" | "prompt"
  >("unknown");
  const [audioInputs, setAudioInputs] = React.useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = React.useState<MediaDeviceInfo[]>(
    [],
  );
  const [stats, setStats] = React.useState<SoftphoneStats | null>(null);
  const [showMicGate, setShowMicGate] = React.useState(false);

  // Refs
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const simpleUserRef = React.useRef<Web.SimpleUser | null>(null);
  const reconnectMgr = React.useRef(new ReconnectManager());
  const stopStatsRef = React.useRef<(() => void) | null>(null);
  const reconnectAttemptRef = React.useRef(0);

  // --------------------------------------------------------------------------
  // Device enumeration
  // --------------------------------------------------------------------------
  const refreshDevices = React.useCallback(async () => {
    const lists = await enumerateAudioDevices();
    setAudioInputs(lists.audioInputs);
    setAudioOutputs(lists.audioOutputs);
  }, []);

  // --------------------------------------------------------------------------
  // Teardown helper
  // --------------------------------------------------------------------------
  const teardown = React.useCallback(async (su: Web.SimpleUser) => {
    const deadline = new Promise<void>((r) => setTimeout(r, TEARDOWN_DEADLINE_MS));
    try {
      await Promise.race([
        (async () => {
          await su.hangup().catch(() => undefined);
          await su.unregister().catch(() => undefined);
          await su.disconnect().catch(() => undefined);
        })(),
        deadline,
      ]);
    } finally {
      stopStatsRef.current?.();
      stopStatsRef.current = null;
      resetStatsCounters();
    }
  }, []);

  // --------------------------------------------------------------------------
  // Boot — fires when sipCreds become available
  // --------------------------------------------------------------------------
  React.useEffect(() => {
    if (!sipCreds || !user) return;

    let cancelled = false;

    (async () => {
      setStatus("connecting");
      setError(null);

      // 1. Check mic permission
      const perm = await queryMicPermission();
      setMicPermission(perm);
      if (perm === "denied") {
        setShowMicGate(true);
        setStatus("error");
        setError({ code: "MIC_PERMISSION_DENIED", message: "Microphone access denied." });
        return;
      }

      // 2. Acquire mic early (user-gesture context from login click is still
      //    valid here on first mount; subsequent tab restores may need a click)
      try {
        await acquireMic(preferredMicId ?? undefined);
        setMicPermission("granted");
        setShowMicGate(false);
      } catch (e) {
        if (cancelled) return;
        const err = e as DOMException;
        if (
          err?.name === "NotAllowedError" ||
          err?.name === "PermissionDeniedError"
        ) {
          setMicPermission("denied");
          setShowMicGate(true);
          setStatus("error");
          setError({ code: "MIC_PERMISSION_DENIED", message: err.message });
        } else {
          setStatus("error");
          setError({ code: "UNKNOWN", message: err?.message ?? "getUserMedia failed", cause: e });
        }
        return;
      }

      if (cancelled) return;

      // 3. Enumerate devices
      await refreshDevices();

      // 4. Build SimpleUser
      const audioEl = audioRef.current;
      if (!audioEl) return;

      const delegate: Web.SimpleUserDelegate = {
        onServerConnect() {
          if (cancelled) return;
          // WSS connected — deliberate no-op; status is set by onRegistered
        },
        onServerDisconnect(err?: Error) {
          if (cancelled) return;
          console.warn("[sip] WSS disconnected", err?.message);
          setStatus("reconnecting");
          callSetPhase("idle");
          // Custom reconnect via reconnect manager
          reconnectMgr.current.scheduleNext(async () => {
            if (cancelled || !simpleUserRef.current) return;
            reconnectAttemptRef.current += 1;
            try {
              await simpleUserRef.current.connect();
              await simpleUserRef.current.register();
              // Re-INVITE if session terminated
              const tenantId = user.tenantId;
              const userId = Number(user.id);
              const domain =
                sipCreds.domain ?? new URL(sipCreds.wsUri).hostname;
              await simpleUserRef.current.call(
                `sip:${parkExtFor(tenantId, userId)}@${domain}`,
              );
            } catch {
              // will retry on next onServerDisconnect
            }
          });
        },
        onRegistered() {
          if (cancelled) return;
          reconnectMgr.current.reset();
          reconnectAttemptRef.current = 0;
          setStatus("registered");
        },
        onUnregistered() {
          if (cancelled) return;
          setStatus("idle");
        },
        onCallReceived: async () => {
          if (!simpleUserRef.current) return;
          // Auto-answer — agent has consented by logging in
          await simpleUserRef.current.answer();
        },
        onCallAnswered() {
          if (cancelled) return;
          setStatus("on-call");
          callSetPhase("active");

          // Apply volume and speaker preferences
          if (audioEl) {
            audioEl.volume = volume;
            if (preferredSpeakerId) {
              setSpeakerDevice(audioEl, preferredSpeakerId).catch(() => undefined);
            }
            audioEl.play().catch(() => {
              // AudioGate in AgentShell handles the retry
              console.warn("[sip] audio.play() rejected — AudioGate will recover");
            });
          }

          // Start stats polling
          stopStatsRef.current?.();
          stopStatsRef.current = startStatsPoller(
            () => {
              const su = simpleUserRef.current;
              if (!su) return null;
              // Access the peer connection from the session manager
              const anyU = su as unknown as {
                sessionManager?: {
                  session?: {
                    sessionDescriptionHandler?: {
                      peerConnection?: RTCPeerConnection;
                    };
                  };
                };
              };
              return (
                anyU.sessionManager?.session?.sessionDescriptionHandler
                  ?.peerConnection ?? null
              );
            },
            (s) => setStats(s),
            statsIntervalMs ?? 5000,
          );
        },
        onCallHangup() {
          if (cancelled) return;
          setStatus("registered");
          setOnHold(false);
          setStats(null);
          resetStatsCounters();
          stopStatsRef.current?.();
          stopStatsRef.current = null;
          callSetPhase("idle");
        },
        onCallHold(held: boolean) {
          if (cancelled) return;
          setOnHold(held);
          setStatus(held ? "on-hold" : "on-call");
          callSetPhase(held ? "hold" : "active");
        },
      };

      let su: Web.SimpleUser;
      try {
        su = createSimpleUser(
          sipCreds,
          { id: user.id, tenantId: user.tenantId },
          audioEl,
          {
            micDeviceId: preferredMicId ?? undefined,
            iceTransportPolicy: forceTurn ? "relay" : "all",
            statsIntervalMs: statsIntervalMs ?? 5000,
          },
          delegate,
        );
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError({ code: "WSS_TLS_FAIL", message: "Failed to create SimpleUser", cause: e });
        return;
      }

      simpleUserRef.current = su;

      // 5. Connect
      try {
        await su.connect();
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError({ code: "WSS_TLS_FAIL", message: "WSS connection failed", cause: e });
        return;
      }
      if (cancelled) return;

      // 6. Register
      try {
        await su.register();
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError({ code: "REGISTER_FAIL", message: "SIP REGISTER failed", cause: e });
        return;
      }
      if (cancelled) return;

      // 7. Call park extension → joins agent_t<tid>_u<uid>@default
      const tenantId = user.tenantId;
      const userId = Number(user.id);
      const domain = sipCreds.domain ?? new URL(sipCreds.wsUri).hostname;
      const target = `sip:${parkExtFor(tenantId, userId)}@${domain}`;

      try {
        await su.call(target);
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError({ code: "INVITE_FAIL", message: `INVITE to ${target} failed`, cause: e });
        return;
      }

      // 8. Listen for device changes
      if (navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
      }

      // 9. Online event → collapse reconnect latency
      const onOnline = () => {
        if (cancelled || !simpleUserRef.current) return;
        simpleUserRef.current.connect().catch(() => undefined);
      };
      window.addEventListener("online", onOnline);

      return () => {
        window.removeEventListener("online", onOnline);
      };
    })();

    return () => {
      cancelled = true;
      if (navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
      }
      const su = simpleUserRef.current;
      simpleUserRef.current = null;
      reconnectMgr.current.cancel();
      if (su) {
        teardown(su).catch(() => undefined);
      }
      setStatus("idle");
      setError(null);
      setOnHold(false);
      setStats(null);
      stopStatsRef.current?.();
      stopStatsRef.current = null;
    };
    // Intentional dependency subset: re-run only when creds or user identity
    // changes, not on every useUiStore update (prefs are read at effect time).
  }, [sipCreds?.wsUri, sipCreds?.authPass, user?.id]);

  // --------------------------------------------------------------------------
  // Volume sync
  // --------------------------------------------------------------------------
  React.useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = volume;
  }, [volume]);

  // --------------------------------------------------------------------------
  // Controls
  // --------------------------------------------------------------------------

  const mute = React.useCallback(() => {
    simpleUserRef.current?.mute();
    callToggleMute();
  }, [callToggleMute]);

  const unmute = React.useCallback(() => {
    simpleUserRef.current?.unmute();
    callToggleMute();
  }, [callToggleMute]);

  const hold = React.useCallback(async () => {
    if (!simpleUserRef.current) return;
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("hold timeout")), 5000),
    );
    await Promise.race([simpleUserRef.current.hold(), timeout]).catch(() => {
      // revert UI if hold timed out
      setOnHold(false);
    });
  }, []);

  const unhold = React.useCallback(async () => {
    if (!simpleUserRef.current) return;
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("unhold timeout")), 5000),
    );
    await Promise.race([simpleUserRef.current.unhold(), timeout]).catch(() => {
      setOnHold(true);
    });
  }, []);

  const sendDtmfCmd = React.useCallback(
    (digits: string) => {
      if (!simpleUserRef.current) return;
      sendDtmf(simpleUserRef.current, digits, dtmfMode ?? "rfc2833").catch(
        () => undefined,
      );
    },
    [dtmfMode],
  );

  const hangup = React.useCallback(async () => {
    if (!simpleUserRef.current) return;
    await simpleUserRef.current.hangup().catch(() => undefined);
  }, []);

  const selectMic = React.useCallback(
    async (deviceId: string) => {
      useUiStore.setState({ preferredMicId: deviceId });
      const su = simpleUserRef.current;
      if (!su) return;
      // Try replaceTrack first (no re-INVITE)
      const anyU = su as unknown as {
        sessionManager?: {
          session?: {
            sessionDescriptionHandler?: {
              peerConnection?: RTCPeerConnection;
            };
          };
        };
      };
      const pc =
        anyU.sessionManager?.session?.sessionDescriptionHandler?.peerConnection;
      if (pc) {
        await replaceAudioTrack(pc, deviceId).catch(() => undefined);
      }
    },
    [],
  );

  const selectSpeaker = React.useCallback(async (deviceId: string) => {
    useUiStore.setState({ preferredSpeakerId: deviceId });
    const el = audioRef.current;
    if (el) {
      await setSpeakerDevice(el, deviceId);
    }
  }, []);

  const setVolumeCmd = React.useCallback(
    (level: number) => {
      setVolume(level);
    },
    [setVolume],
  );

  const retryConnect = React.useCallback(() => {
    // Trigger a re-connect by toggling mic permission gate off
    setShowMicGate(false);
    setStatus("connecting");
    acquireMic(preferredMicId ?? undefined)
      .then(() => {
        setMicPermission("granted");
        if (simpleUserRef.current) {
          simpleUserRef.current.connect().catch(() => undefined);
        }
      })
      .catch(() => {
        setMicPermission("denied");
        setShowMicGate(true);
      });
  }, [preferredMicId]);

  const registered = ["registered", "on-call", "on-hold"].includes(status);

  // --------------------------------------------------------------------------
  // Context value
  // --------------------------------------------------------------------------
  const value = React.useMemo<SoftphoneContextValue>(
    () => ({
      status,
      registered,
      error,
      muted: callMuted,
      onHold,
      micPermission,
      audioInputs,
      audioOutputs,
      stats,
      mute,
      unmute,
      hold,
      unhold,
      sendDtmf: sendDtmfCmd,
      hangup,
      selectMic,
      selectSpeaker,
      setVolume: setVolumeCmd,
      retryConnect,
    }),
    [
      status,
      registered,
      error,
      callMuted,
      onHold,
      micPermission,
      audioInputs,
      audioOutputs,
      stats,
      mute,
      unmute,
      hold,
      unhold,
      sendDtmfCmd,
      hangup,
      selectMic,
      selectSpeaker,
      setVolumeCmd,
      retryConnect,
    ],
  );

  return (
    <SoftphoneContext.Provider value={value}>
      <AudioElement ref={audioRef} />
      {showMicGate && <MicPermissionGate onRetry={retryConnect} />}
      {children}
    </SoftphoneContext.Provider>
  );
}
