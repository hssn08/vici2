// I05 — VM drop upload validation unit tests.
// Tests the validation logic without requiring a real DB or ffmpeg.

import { describe, it, expect } from "vitest";

// ─── Validation helpers (extracted for testing) ───────────────────────────────

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DURATION_SEC = 120;
const ALLOWED_CONTENT_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp3", "audio/x-wav"]);

function validateContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

function validateFileSize(sizeBytes: number): boolean {
  return sizeBytes <= MAX_UPLOAD_BYTES;
}

function validateDuration(durationSec: number): boolean {
  return durationSec <= MAX_DURATION_SEC;
}

function buildLocalPath(vmdropDir: string, tenantId: string, assetId: string): string {
  return `${vmdropDir}/${tenantId}/${assetId}.wav`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VM Drop Upload Validation", () => {
  describe("content-type validation", () => {
    it("accepts audio/wav", () => {
      expect(validateContentType("audio/wav")).toBe(true);
    });

    it("accepts audio/mpeg (MP3)", () => {
      expect(validateContentType("audio/mpeg")).toBe(true);
    });

    it("accepts audio/mp3", () => {
      expect(validateContentType("audio/mp3")).toBe(true);
    });

    it("accepts audio/x-wav", () => {
      expect(validateContentType("audio/x-wav")).toBe(true);
    });

    it("rejects video/mp4", () => {
      expect(validateContentType("video/mp4")).toBe(false);
    });

    it("rejects application/octet-stream", () => {
      expect(validateContentType("application/octet-stream")).toBe(false);
    });

    it("rejects text/plain", () => {
      expect(validateContentType("text/plain")).toBe(false);
    });
  });

  describe("file size validation", () => {
    it("accepts exactly 10 MB", () => {
      expect(validateFileSize(MAX_UPLOAD_BYTES)).toBe(true);
    });

    it("accepts 1 byte", () => {
      expect(validateFileSize(1)).toBe(true);
    });

    it("accepts typical 1 MB WAV", () => {
      expect(validateFileSize(1024 * 1024)).toBe(true);
    });

    it("rejects 10 MB + 1 byte", () => {
      expect(validateFileSize(MAX_UPLOAD_BYTES + 1)).toBe(false);
    });

    it("rejects 20 MB", () => {
      expect(validateFileSize(20 * 1024 * 1024)).toBe(false);
    });
  });

  describe("duration validation", () => {
    it("accepts exactly 120 seconds", () => {
      expect(validateDuration(120)).toBe(true);
    });

    it("accepts 30 seconds", () => {
      expect(validateDuration(30)).toBe(true);
    });

    it("accepts 0 seconds", () => {
      expect(validateDuration(0)).toBe(true);
    });

    it("rejects 121 seconds", () => {
      expect(validateDuration(121)).toBe(false);
    });

    it("rejects 300 seconds", () => {
      expect(validateDuration(300)).toBe(false);
    });
  });

  describe("local path generation", () => {
    it("generates correct path for tenant 1, asset 42", () => {
      const path = buildLocalPath("/var/lib/vici2/vmdrop", "1", "42");
      expect(path).toBe("/var/lib/vici2/vmdrop/1/42.wav");
    });

    it("generates correct path for tenant 99, asset 1001", () => {
      const path = buildLocalPath("/var/lib/vici2/vmdrop", "99", "1001");
      expect(path).toBe("/var/lib/vici2/vmdrop/99/1001.wav");
    });

    it("always uses .wav extension (post-transcode)", () => {
      const path = buildLocalPath("/var/lib/vici2/vmdrop", "1", "5");
      expect(path.endsWith(".wav")).toBe(true);
    });
  });
});
