/**
 * A02 — SIP.js Web.SimpleUser factory.
 *
 * Builds a SimpleUser with the required options for FreeSWITCH WSS:
 * - WSS to wss://<fs-host>:7443 (SIP.js sets "sip" subprotocol automatically)
 * - DTLS-SRTP (mandatory, handled by browser/FS)
 * - OPUS+PCMU codec preference (set by FS sdp filter; browser negotiates)
 * - RFC 4733 DTMF (sendDTMFUsingSessionDescriptionHandler: true)
 * - RTCP-MUX required, bundle max-bundle
 * - ICE servers from F05 sip_creds (STUN Phase 1; TURN Phase 2)
 */

import { Web } from "sip.js";
import type { SipCreds } from "@/lib/stores/auth";
import { pinoLogConnector } from "./log";

export interface SimpleUserPrefs {
  micDeviceId?: string;
  iceTransportPolicy?: RTCIceTransportPolicy;
  statsIntervalMs?: number;
}

/**
 * Build and return a configured Web.SimpleUser.
 *
 * @param sipCreds - SIP credentials from useAuthStore (F05 login response)
 * @param user - The agent's numeric id and tenantId
 * @param remoteAudioEl - Hidden <audio> element for the remote stream
 * @param prefs - Runtime preferences from useUiStore
 * @param delegate - SimpleUserDelegate wired by SipProvider
 */
export function createSimpleUser(
  sipCreds: SipCreds,
  user: { id: string; tenantId: number },
  remoteAudioEl: HTMLAudioElement,
  prefs: SimpleUserPrefs,
  delegate: Web.SimpleUserDelegate,
): Web.SimpleUser {
  const domain =
    sipCreds.domain ??
    new URL(sipCreds.wsUri).hostname;

  const aor = `sip:${user.id}@${domain}`;

  const iceServers: RTCIceServer[] = sipCreds.iceServers ?? [
    { urls: ["stun:stun.l.google.com:19302"] },
  ];

  const peerConnectionConfiguration: RTCConfiguration = {
    iceServers,
    iceTransportPolicy: prefs.iceTransportPolicy ?? "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };

  const options: Web.SimpleUserOptions = {
    aor,
    delegate,

    media: {
      constraints: { audio: true, video: false },
      remote: { audio: remoteAudioEl },
    },

    // RFC 4733 telephone-event via RTCDTMFSender (F03: rfc2833-pt=101)
    sendDTMFUsingSessionDescriptionHandler: true,

    // SIP.js-internal reconnect (our custom backoff wraps on top)
    reconnectionAttempts: 3,
    reconnectionDelay: 4,

    registererOptions: {
      refreshFrequency: 90, // refresh at 90% of expires (~540s of 600s)
    },

    userAgentOptions: {
      authorizationUsername: user.id,
      authorizationPassword: sipCreds.authPass,
      transportOptions: {
        server: sipCreds.wsUri, // SIP.js sets "sip" subprotocol automatically
      },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration,
        constraints: {
          audio: prefs.micDeviceId
            ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: { ideal: 48000 },
                deviceId: { exact: prefs.micDeviceId },
              }
            : {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: { ideal: 48000 },
              },
          video: false,
        },
      },
      logLevel: process.env.NODE_ENV === "development" ? "debug" : "warn",
      logBuiltinEnabled: false,
      logConfiguration: false,
      logConnector: pinoLogConnector,
    },
  };

  return new Web.SimpleUser(sipCreds.wsUri, options);
}
