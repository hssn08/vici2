/**
 * A02 unit tests — createSimpleUser.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock sip.js before imports
vi.mock("sip.js", () => {
  const SimpleUser = vi.fn().mockImplementation((server: string, options: unknown) => ({
    _server: server,
    _options: options,
  }));
  return { Web: { SimpleUser } };
});

import { createSimpleUser } from "@/lib/sip/createSimpleUser";
import { Web } from "sip.js";
import type { SipCreds } from "@/lib/stores/auth";

const mockCreds: SipCreds = {
  wsUri: "wss://fs.example.com:7443",
  sipUri: "sip:42@vici2.local",
  authUser: "42",
  authPass: "s3cr3t",
  domain: "vici2.local",
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

const mockUser = { id: "42", tenantId: 1 };
const mockAudioEl = document.createElement("audio");
const mockDelegate = {};

describe("createSimpleUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("instantiates SimpleUser with the WSS URI", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    expect(Web.SimpleUser).toHaveBeenCalledWith(
      "wss://fs.example.com:7443",
      expect.any(Object),
    );
  });

  it("sets aor from user.id and domain", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.aor).toBe("sip:42@vici2.local");
  });

  it("configures authorizationPassword from sipCreds.authPass", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.userAgentOptions.authorizationPassword).toBe("s3cr3t");
  });

  it("disables logBuiltinEnabled", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.userAgentOptions.logBuiltinEnabled).toBe(false);
  });

  it("enables sendDTMFUsingSessionDescriptionHandler for RFC 4733", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.sendDTMFUsingSessionDescriptionHandler).toBe(true);
  });

  it("sets refreshFrequency to 90", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.registererOptions?.refreshFrequency).toBe(90);
  });

  it("passes iceServers to SDH options", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sdhOpts = opts.userAgentOptions.sessionDescriptionHandlerFactoryOptions;
    expect(sdhOpts.peerConnectionConfiguration.iceServers).toEqual(
      mockCreds.iceServers,
    );
  });

  it("sets iceTransportPolicy to relay when forceTurn=true", () => {
    createSimpleUser(
      mockCreds,
      mockUser,
      mockAudioEl,
      { iceTransportPolicy: "relay" },
      mockDelegate,
    );
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sdhOpts = opts.userAgentOptions.sessionDescriptionHandlerFactoryOptions;
    expect(sdhOpts.peerConnectionConfiguration.iceTransportPolicy).toBe("relay");
  });

  it("uses default stun when iceServers not in creds", () => {
    const credsNoIce: SipCreds = { ...mockCreds, iceServers: undefined };
    createSimpleUser(credsNoIce, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sdhOpts = opts.userAgentOptions.sessionDescriptionHandlerFactoryOptions;
    expect(sdhOpts.peerConnectionConfiguration.iceServers[0].urls).toContain(
      "stun:stun.l.google.com:19302",
    );
  });

  it("sets remote audio element in media options", () => {
    createSimpleUser(mockCreds, mockUser, mockAudioEl, {}, mockDelegate);
    const opts = (Web.SimpleUser as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.media.remote.audio).toBe(mockAudioEl);
  });
});
