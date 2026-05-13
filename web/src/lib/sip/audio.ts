/**
 * A02 — Audio device management utilities.
 *
 * Provides:
 * - Device enumeration (mic + speaker lists)
 * - replaceTrack for mid-call mic switch (no re-INVITE)
 * - setSinkId for speaker selection (feature-detected; Safari skipped)
 * - getUserMedia with A02's required constraints
 */

export interface AudioDeviceLists {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

/**
 * Enumerate available audio input and output devices.
 * Requires at minimum a granted mic permission to get labels.
 */
export async function enumerateAudioDevices(): Promise<AudioDeviceLists> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return { audioInputs: [], audioOutputs: [] };
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    audioInputs: all.filter((d) => d.kind === "audioinput"),
    audioOutputs: all.filter((d) => d.kind === "audiooutput"),
  };
}

/**
 * Build getUserMedia audio constraints for A02.
 */
export function buildAudioConstraints(
  deviceId?: string,
): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: { ideal: 48000 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/**
 * Acquire a microphone stream with A02 constraints.
 * Throws on permission denied.
 */
export async function acquireMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: buildAudioConstraints(deviceId),
    video: false,
  });
}

/**
 * Switch microphone mid-call via RTCRtpSender.replaceTrack.
 * No SDP renegotiation required.
 *
 * @returns true if replaceTrack succeeded, false if pc not available
 */
export async function replaceAudioTrack(
  peerConnection: RTCPeerConnection,
  newDeviceId: string,
): Promise<boolean> {
  let newStream: MediaStream;
  try {
    newStream = await acquireMic(newDeviceId);
  } catch {
    return false;
  }
  const [newTrack] = newStream.getAudioTracks();
  if (!newTrack) return false;

  const sender = peerConnection
    .getSenders()
    .find((s) => s.track?.kind === "audio");
  if (!sender) return false;

  await sender.replaceTrack(newTrack);
  return true;
}

/**
 * Set audio output device on an HTMLAudioElement (Chrome/Edge/Firefox 140+).
 * Safari does NOT implement setSinkId — this function is a no-op there.
 *
 * @returns 'ok' | 'unsupported' | 'error'
 */
export async function setSpeakerDevice(
  audioEl: HTMLAudioElement,
  deviceId: string,
): Promise<"ok" | "unsupported" | "error"> {
  if (!("setSinkId" in audioEl)) return "unsupported";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (audioEl as any).setSinkId(deviceId);
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * Query microphone permission state.
 */
export async function queryMicPermission(): Promise<
  "granted" | "denied" | "prompt" | "unknown"
> {
  if (typeof navigator === "undefined" || !navigator.permissions) {
    return "unknown";
  }
  try {
    const result = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return result.state as "granted" | "denied" | "prompt";
  } catch {
    return "unknown";
  }
}
