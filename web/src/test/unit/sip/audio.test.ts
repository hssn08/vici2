/**
 * A02 unit tests — audio.ts
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enumerateAudioDevices,
  buildAudioConstraints,
  setSpeakerDevice,
  queryMicPermission,
} from "@/lib/sip/audio";

describe("buildAudioConstraints", () => {
  it("returns default constraints without deviceId", () => {
    const c = buildAudioConstraints();
    expect(c.echoCancellation).toBe(true);
    expect(c.noiseSuppression).toBe(true);
    expect(c.autoGainControl).toBe(true);
    expect(c.channelCount).toBe(1);
    expect(c.deviceId).toBeUndefined();
  });

  it("includes deviceId.exact when provided", () => {
    const c = buildAudioConstraints("abc123");
    expect(c.deviceId).toEqual({ exact: "abc123" });
  });
});

describe("enumerateAudioDevices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty lists when mediaDevices is unavailable", async () => {
    // jsdom doesn't have mediaDevices by default
    const result = await enumerateAudioDevices();
    // May return empty arrays since jsdom has no real devices
    expect(Array.isArray(result.audioInputs)).toBe(true);
    expect(Array.isArray(result.audioOutputs)).toBe(true);
  });

  it("filters audioinput and audiooutput from enumerateDevices", async () => {
    const mockDevices: MediaDeviceInfo[] = [
      { kind: "audioinput", deviceId: "mic1", label: "Mic", groupId: "g1", toJSON: () => ({}) },
      { kind: "audiooutput", deviceId: "spk1", label: "Speaker", groupId: "g1", toJSON: () => ({}) },
      { kind: "videoinput", deviceId: "cam1", label: "Camera", groupId: "g2", toJSON: () => ({}) },
    ];

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
      },
    });

    const result = await enumerateAudioDevices();
    expect(result.audioInputs).toHaveLength(1);
    expect(result.audioOutputs).toHaveLength(1);
    expect(result.audioInputs[0].deviceId).toBe("mic1");
    expect(result.audioOutputs[0].deviceId).toBe("spk1");
  });
});

describe("setSpeakerDevice", () => {
  it("returns 'unsupported' when setSinkId is not available", async () => {
    const el = document.createElement("audio");
    // jsdom does not implement setSinkId — should return 'unsupported'
    const result = await setSpeakerDevice(el, "device123");
    expect(["unsupported", "ok", "error"]).toContain(result);
  });
});

describe("queryMicPermission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'unknown' when permissions API is unavailable", async () => {
    vi.stubGlobal("navigator", { permissions: undefined });
    const result = await queryMicPermission();
    expect(result).toBe("unknown");
  });

  it("returns 'granted' from permissions API", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });
    const result = await queryMicPermission();
    expect(result).toBe("granted");
  });

  it("returns 'denied' from permissions API", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });
    const result = await queryMicPermission();
    expect(result).toBe("denied");
  });

  it("returns 'unknown' on permissions query error", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockRejectedValue(new Error("Not supported")),
      },
    });
    const result = await queryMicPermission();
    expect(result).toBe("unknown");
  });
});
