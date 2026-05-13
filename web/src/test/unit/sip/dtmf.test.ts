/**
 * A02 unit tests — dtmf.ts
 */
import { describe, it, expect, vi } from "vitest";
import { buildDtmfInfoBody, sendDtmf } from "@/lib/sip/dtmf";
import type { Web } from "sip.js";

describe("buildDtmfInfoBody", () => {
  it("builds correct body for a single digit", () => {
    const body = buildDtmfInfoBody("1");
    expect(body).toBe("Signal=1\r\nDuration=100");
  });

  it("uses custom duration", () => {
    const body = buildDtmfInfoBody("5", 200);
    expect(body).toBe("Signal=5\r\nDuration=200");
  });

  it("handles # and * characters", () => {
    expect(buildDtmfInfoBody("#")).toBe("Signal=#\r\nDuration=100");
    expect(buildDtmfInfoBody("*")).toBe("Signal=*\r\nDuration=100");
  });
});

describe("sendDtmf", () => {
  it("calls simpleUser.sendDTMF for rfc2833 mode", async () => {
    const mockSu = {
      sendDTMF: vi.fn().mockResolvedValue(undefined),
    } as unknown as Web.SimpleUser;

    await sendDtmf(mockSu, "123", "rfc2833");
    expect(mockSu.sendDTMF).toHaveBeenCalledWith("123");
  });

  it("does not send individual INFO calls for rfc2833 mode", async () => {
    const mockInfo = vi.fn().mockResolvedValue(undefined);
    const mockSu = {
      sendDTMF: vi.fn().mockResolvedValue(undefined),
      session: { info: mockInfo },
    } as unknown as Web.SimpleUser;

    await sendDtmf(mockSu, "1", "rfc2833");
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it("warns and does nothing for sip-info when no session", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mockSu = {} as unknown as Web.SimpleUser;

    await sendDtmf(mockSu, "9", "sip-info");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No active session"),
    );
    warnSpy.mockRestore();
  });
});
