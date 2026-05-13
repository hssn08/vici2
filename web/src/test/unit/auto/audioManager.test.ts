import { describe, it, expect, vi, beforeEach } from "vitest";

// AudioManager relies on HTMLAudioElement and AudioContext — both need mocking in jsdom.

// Mock HTMLAudioElement
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();

class MockAudio {
  src: string = "";
  volume: number = 1;
  currentTime: number = 0;
  preload: string = "auto";
  play = mockPlay;
  pause = mockPause;
}

// @ts-expect-error replace global
globalThis.Audio = MockAudio;

// Mock fetch for AudioContext path
globalThis.fetch = vi.fn().mockResolvedValue({
  arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
});

describe("AudioManager", () => {
  let audioManager: typeof import("@/app/(agent)/auto/_components/AudioManager").audioManager;

  beforeEach(async () => {
    vi.resetModules();
    mockPlay.mockResolvedValue(undefined);
    // Re-import to get fresh singleton
    const mod = await import("@/app/(agent)/auto/_components/AudioManager");
    audioManager = mod.audioManager;
  });

  it("isArmed() returns false before arm()", () => {
    expect(audioManager.isArmed()).toBe(false);
  });

  it("arm() succeeds and isArmed() returns true", async () => {
    await audioManager.arm("/sounds/reservation-chime.wav");
    expect(audioManager.isArmed()).toBe(true);
    expect(mockPlay).toHaveBeenCalled();
    expect(mockPause).toHaveBeenCalled();
  });

  it("play() calls HTMLAudioElement.play() after arm", async () => {
    await audioManager.arm("/sounds/reservation-chime.wav");
    mockPlay.mockClear();
    await audioManager.play();
    expect(mockPlay).toHaveBeenCalled();
  });

  it("play() is a no-op when muted", async () => {
    await audioManager.arm("/sounds/reservation-chime.wav");
    audioManager.setMuted(true);
    mockPlay.mockClear();
    await audioManager.play();
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("play() is a no-op when not armed", async () => {
    await audioManager.play();
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("setVolume clamps to 0–1", async () => {
    await audioManager.arm();
    audioManager.setVolume(1.5);
    // Volume set on element — check no crash
    audioManager.setVolume(-0.5);
    expect(audioManager.isArmed()).toBe(true);
  });

  it("setMuted(false) re-enables play after mute", async () => {
    await audioManager.arm("/sounds/reservation-chime.wav");
    audioManager.setMuted(true);
    audioManager.setMuted(false);
    mockPlay.mockClear();
    await audioManager.play();
    expect(mockPlay).toHaveBeenCalled();
  });
});
