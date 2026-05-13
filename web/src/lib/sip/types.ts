/**
 * A02 — SIP.js softphone type definitions (FROZEN).
 * These are the public-facing types consumed by A04/A05/A06/A07/S02.
 */

export type SoftphoneStatus =
  | "idle" // no creds yet
  | "connecting" // WSS opening or REGISTER in flight
  | "registered" // REGISTER 200 OK, no INVITE yet
  | "on-call" // park leg active
  | "on-hold" // re-INVITE sendonly succeeded
  | "reconnecting" // WSS / REGISTER recovery in progress
  | "error"; // unrecoverable; see error field

export interface SoftphoneError {
  code:
    | "MIC_PERMISSION_DENIED"
    | "WSS_TLS_FAIL"
    | "REGISTER_FAIL"
    | "INVITE_FAIL"
    | "TRANSPORT_LOST"
    | "UNKNOWN";
  message: string;
  cause?: unknown;
}

export interface SoftphoneStats {
  jitterMs: number;
  packetLossPct: number;
  rttMs: number;
  audioLevel: number; // 0..1
}

export interface SoftphoneContextValue {
  // state
  status: SoftphoneStatus;
  registered: boolean; // === status in {'registered','on-call','on-hold'}
  error: SoftphoneError | null;
  muted: boolean;
  onHold: boolean;
  micPermission: "unknown" | "granted" | "denied" | "prompt";
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  stats: SoftphoneStats | null;

  // controls
  mute(): void;
  unmute(): void;
  hold(): Promise<void>;
  unhold(): Promise<void>;
  sendDtmf(digits: string): void;
  hangup(): Promise<void>;
  selectMic(deviceId: string): Promise<void>;
  selectSpeaker(deviceId: string): Promise<void>;
  setVolume(level: number): void;
  retryConnect(): void;
}
