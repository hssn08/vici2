/**
 * A02 — SIP module barrel export.
 *
 * Public surface consumed by A04, A05, A06, A07, S02.
 * Internal helpers (createSimpleUser, audio, dtmf, stats, reconnect) are
 * not re-exported here — import them directly from their modules if needed.
 */

export { SipProvider } from "./SipProvider";
export { useSoftphone } from "./useSoftphone";
export { DevicePicker } from "./deviceUx/DevicePicker";
export { MicPermissionGate } from "./deviceUx/MicPermissionGate";
export type {
  SoftphoneStatus,
  SoftphoneError,
  SoftphoneStats,
  SoftphoneContextValue,
} from "./types";
export { parkExtFor, confNameFor } from "./parkExt";
