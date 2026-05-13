import { describe, it, expect, beforeEach } from "vitest";
import { useCallStore } from "@/lib/stores/call";

describe("useCallStore", () => {
  beforeEach(() => {
    useCallStore.getState().clearCall();
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

  // A05 additions
  it("setRecording updates recording state", () => {
    useCallStore.getState().setRecording("on");
    expect(useCallStore.getState().recording).toBe("on");
    useCallStore.getState().setRecording("paused");
    expect(useCallStore.getState().recording).toBe("paused");
    useCallStore.getState().setRecording("pending");
    expect(useCallStore.getState().recording).toBe("pending");
    useCallStore.getState().setRecording("off");
    expect(useCallStore.getState().recording).toBe("off");
  });

  it("setConsent updates consent status", () => {
    useCallStore.getState().setConsent("ALLOW");
    expect(useCallStore.getState().consent).toBe("ALLOW");
    useCallStore.getState().setConsent("REQUIRE_ACTIVE");
    expect(useCallStore.getState().consent).toBe("REQUIRE_ACTIVE");
    useCallStore.getState().setConsent(null);
    expect(useCallStore.getState().consent).toBeNull();
  });

  it("setNotes updates notes", () => {
    useCallStore.getState().setNotes("hello world");
    expect(useCallStore.getState().notes).toBe("hello world");
  });

  it("addParticipant and removeParticipant manage the list", () => {
    const p = { uuid: "p1", role: "third_party" as const, muted: false, joinedAt: Date.now() };
    useCallStore.getState().addParticipant(p);
    expect(useCallStore.getState().threeWayParticipants).toHaveLength(1);
    useCallStore.getState().removeParticipant("p1");
    expect(useCallStore.getState().threeWayParticipants).toHaveLength(0);
  });

  it("updateParticipant patches a participant", () => {
    const p = { uuid: "p2", role: "customer" as const, muted: false, joinedAt: Date.now() };
    useCallStore.getState().addParticipant(p);
    useCallStore.getState().updateParticipant("p2", { muted: true });
    expect(useCallStore.getState().threeWayParticipants[0]!.muted).toBe(true);
  });

  it("setPhase to wrapup sets wrapupStartAt", () => {
    useCallStore.setState({ phase: "active" });
    useCallStore.getState().setPhase("wrapup");
    expect(useCallStore.getState().wrapupStartAt).not.toBeNull();
  });

  it("clearCall resets all state to empty", () => {
    useCallStore.setState({ callUuid: "u1", phase: "active", notes: "test" });
    useCallStore.getState().clearCall();
    const s = useCallStore.getState();
    expect(s.callUuid).toBeNull();
    expect(s.phase).toBe("idle");
    expect(s.notes).toBe("");
  });

  it("setActiveCall accepts campaign config", () => {
    useCallStore.getState().setActiveCall({
      callUuid: "u2",
      direction: "outbound",
      lead: { id: "l2", phoneE164: "+15559999999" },
      campaign: {
        id: 1, name: "Test Campaign", recording_mode: "ONDEMAND",
        wrapup_seconds: 45, hangup_grace_seconds: 5,
        hot_keys_active: true, webform_url: null,
      },
    });
    const s = useCallStore.getState();
    expect(s.campaign?.name).toBe("Test Campaign");
    expect(s.campaign?.recording_mode).toBe("ONDEMAND");
  });
});
