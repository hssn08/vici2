import { describe, it, expect, beforeEach } from "vitest";
import { useDialStore } from "@/lib/stores/dial";

const reset = () => useDialStore.getState().resetDial();

describe("useDialStore — state machine", () => {
  beforeEach(reset);

  it("starts in idle state", () => {
    expect(useDialStore.getState().dialPhase.state).toBe("idle");
  });

  it("openModal transitions idle → modal_open", () => {
    useDialStore.getState().openModal();
    expect(useDialStore.getState().dialPhase.state).toBe("modal_open");
  });

  it("closeModal transitions modal_open → idle", () => {
    useDialStore.getState().openModal();
    useDialStore.getState().closeModal();
    expect(useDialStore.getState().dialPhase.state).toBe("idle");
  });

  it("setLead transitions any state → lead_selected", () => {
    const lead = makeLead();
    useDialStore.getState().setLead(lead, "manual");
    const phase = useDialStore.getState().dialPhase;
    expect(phase.state).toBe("lead_selected");
    if (phase.state === "lead_selected") {
      expect(phase.lead.phoneE164).toBe("+15005550006");
    }
  });

  it("startCallRequested from lead_selected → call_requested", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().startCallRequested();
    expect(useDialStore.getState().dialPhase.state).toBe("call_requested");
  });

  it("setAttemptUuid from call_requested → calling", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().startCallRequested();
    useDialStore.getState().setAttemptUuid("attempt-uuid-123");
    const phase = useDialStore.getState().dialPhase;
    expect(phase.state).toBe("calling");
    if (phase.state === "calling") {
      expect(phase.attemptUuid).toBe("attempt-uuid-123");
      expect(phase.callUuid).toBeNull();
    }
  });

  it("setCallUuid updates callUuid in calling state", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().startCallRequested();
    useDialStore.getState().setAttemptUuid("attempt-uuid-123");
    useDialStore.getState().setCallUuid("call-uuid-abc");
    const phase = useDialStore.getState().dialPhase;
    if (phase.state === "calling") {
      expect(phase.callUuid).toBe("call-uuid-abc");
    } else {
      throw new Error("Expected calling state");
    }
  });

  it("setBlock from lead_selected → blocked with lead preserved", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().setBlock({
      code: "DNC_BLOCKED",
      message: "On federal DNC list",
    });
    const phase = useDialStore.getState().dialPhase;
    expect(phase.state).toBe("blocked");
    if (phase.state === "blocked") {
      expect(phase.reason.code).toBe("DNC_BLOCKED");
      expect(phase.lead).not.toBeNull();
    }
  });

  it("clearBlock from blocked (with lead) → lead_selected", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().setBlock({ code: "CALL_FAILED", message: "No answer" });
    useDialStore.getState().clearBlock();
    expect(useDialStore.getState().dialPhase.state).toBe("lead_selected");
  });

  it("clearBlock from blocked (no lead) → idle", () => {
    // Force a block with no lead by going through setBlock after idle
    useDialStore.setState({ dialPhase: { state: "blocked", lead: null, reason: { code: "AGENT_DIAL_LOCK", message: "locked" } } });
    useDialStore.getState().clearBlock();
    expect(useDialStore.getState().dialPhase.state).toBe("idle");
  });

  it("resetDial returns to idle from any state", () => {
    useDialStore.getState().setLead(makeLead());
    useDialStore.getState().startCallRequested();
    useDialStore.getState().resetDial();
    expect(useDialStore.getState().dialPhase.state).toBe("idle");
    expect(useDialStore.getState().hopperClaimToken).toBeNull();
    expect(useDialStore.getState().dialMode).toBeNull();
  });
});

describe("useDialStore — client gates", () => {
  beforeEach(reset);

  it("setClientGates merges partial update", () => {
    useDialStore.getState().setClientGates({ agentReady: true });
    expect(useDialStore.getState().clientGates.agentReady).toBe(true);
    expect(useDialStore.getState().clientGates.phoneValid).toBe(false); // unchanged default
  });

  it("setHopperClaimToken stores token", () => {
    useDialStore.getState().setHopperClaimToken("tok-abc-123");
    expect(useDialStore.getState().hopperClaimToken).toBe("tok-abc-123");
  });

  it("restoreFromServer sets calling state when phase=ringing", () => {
    useDialStore.getState().restoreFromServer({
      attempt_uuid: "restored-uuid",
      phase: "ringing",
      lead: makeLead(),
      started_at: new Date().toISOString(),
    });
    const phase = useDialStore.getState().dialPhase;
    expect(phase.state).toBe("calling");
    if (phase.state === "calling") {
      expect(phase.attemptUuid).toBe("restored-uuid");
    }
  });

  it("restoreFromServer is a no-op when not idle", () => {
    useDialStore.getState().setLead(makeLead());
    // Already lead_selected, not idle
    useDialStore.getState().restoreFromServer({
      attempt_uuid: "should-not-apply",
      phase: "ringing",
      lead: makeLead(),
      started_at: new Date().toISOString(),
    });
    // State should remain lead_selected, not calling
    expect(useDialStore.getState().dialPhase.state).toBe("lead_selected");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLead() {
  return {
    id: 42,
    firstName: "Jane",
    lastName: "Doe",
    vendorLeadCode: null,
    phoneE164: "+15005550006",
    phoneType: "mobile",
    city: "San Francisco",
    state: "California",
    stateAbbr: "CA",
    postalCode: "94102",
    tzOffsetMin: -480,
    tzName: "America/Los_Angeles",
    customData: {},
    calledCount: 0,
    lastCalledAt: null,
    listId: 1,
  };
}
