import { describe, it, expect, beforeEach } from "vitest";
import { useCallStore } from "@/lib/stores/call";

describe("useCallStore", () => {
  beforeEach(() => {
    useCallStore.getState().endCall();
  });

  it("setActiveCall enters ringing phase", () => {
    useCallStore.getState().setActiveCall({
      callUuid: "u1",
      direction: "outbound",
      lead: { id: "l1", phoneE164: "+15551234567" },
    });
    const s = useCallStore.getState();
    expect(s.callUuid).toBe("u1");
    expect(s.phase).toBe("ringing");
    expect(s.lead?.phoneE164).toBe("+15551234567");
  });

  it("toggleMute flips mute", () => {
    const before = useCallStore.getState().muted;
    useCallStore.getState().toggleMute();
    expect(useCallStore.getState().muted).toBe(!before);
  });

  it("patchFromEvent only applies higher seq", () => {
    useCallStore.getState().patchFromEvent({ seq: 5, patch: { phase: "active" } });
    expect(useCallStore.getState().phase).toBe("active");
    useCallStore.getState().patchFromEvent({ seq: 3, patch: { phase: "hold" } });
    expect(useCallStore.getState().phase).toBe("active");
    useCallStore.getState().patchFromEvent({ seq: 6, patch: { phase: "wrapup" } });
    expect(useCallStore.getState().phase).toBe("wrapup");
  });
});
