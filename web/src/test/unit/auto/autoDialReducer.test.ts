import { describe, it, expect } from "vitest";
import {
  autoDialReducer,
  type AutoDialState,
} from "@/app/(agent)/auto/_components/AutoDialShell";

const IDLE: AutoDialState = { status: "idle" };

const SAMPLE_RESERVATION = {
  callUuid: "call-1",
  attemptUuid: "attempt-1",
  lead: { id: "lead-1", phoneE164: "+15551234567" },
  campaignId: 42,
  campaignName: "SOLAR_Q2",
  scriptSnippet: null,
};

function reserved(): AutoDialState {
  return {
    status: "reserved",
    reservation: SAMPLE_RESERVATION,
    startedAt: new Date().toISOString(),
  };
}

describe("autoDialReducer", () => {
  it("IDLE + RESERVATION_RECEIVED → reserved", () => {
    const now = new Date().toISOString();
    const next = autoDialReducer(IDLE, {
      type: "RESERVATION_RECEIVED",
      data: SAMPLE_RESERVATION,
      startedAt: now,
    });
    expect(next.status).toBe("reserved");
    if (next.status === "reserved") {
      expect(next.reservation.callUuid).toBe("call-1");
      expect(next.startedAt).toBe(now);
    }
  });

  it("reserved + CALL_BRIDGED → calling", () => {
    const next = autoDialReducer(reserved(), { type: "CALL_BRIDGED" });
    expect(next.status).toBe("calling");
  });

  it("calling + CALL_HANGUP → wrapup", () => {
    const calling: AutoDialState = { status: "calling" };
    const next = autoDialReducer(calling, { type: "CALL_HANGUP" });
    expect(next.status).toBe("wrapup");
  });

  it("wrapup + DISPO_SUBMITTED → idle", () => {
    const wrapup: AutoDialState = { status: "wrapup" };
    const next = autoDialReducer(wrapup, { type: "DISPO_SUBMITTED" });
    expect(next.status).toBe("idle");
  });

  it("reserved + AGENT_SKIP → idle", () => {
    const next = autoDialReducer(reserved(), { type: "AGENT_SKIP" });
    expect(next.status).toBe("idle");
  });

  it("reserved + RESERVATION_TIMEOUT → missed", () => {
    const next = autoDialReducer(reserved(), { type: "RESERVATION_TIMEOUT" });
    expect(next.status).toBe("missed");
  });

  it("reserved + RESERVATION_EXPIRED → missed", () => {
    const next = autoDialReducer(reserved(), { type: "RESERVATION_EXPIRED" });
    expect(next.status).toBe("missed");
  });

  it("missed + DISMISS_MISSED → paused", () => {
    const missed: AutoDialState = { status: "missed" };
    const next = autoDialReducer(missed, { type: "DISMISS_MISSED" });
    expect(next.status).toBe("paused");
  });

  it("paused + RETURN_TO_AUTODIAL → idle", () => {
    const paused: AutoDialState = { status: "paused" };
    const next = autoDialReducer(paused, { type: "RETURN_TO_AUTODIAL" });
    expect(next.status).toBe("idle");
  });

  it("reserved + SIP_NOT_READY → idle", () => {
    const next = autoDialReducer(reserved(), { type: "SIP_NOT_READY" });
    expect(next.status).toBe("idle");
  });

  it("reserved + CALL_FAILED → idle", () => {
    const next = autoDialReducer(reserved(), { type: "CALL_FAILED", reason: "no answer" });
    expect(next.status).toBe("idle");
  });

  it("reserved + AGENT_ACCEPT keeps reserved (awaiting call.bridged)", () => {
    const next = autoDialReducer(reserved(), { type: "AGENT_ACCEPT" });
    expect(next.status).toBe("reserved");
  });

  it("idle + CALL_BRIDGED is a no-op (illegal transition)", () => {
    const next = autoDialReducer(IDLE, { type: "CALL_BRIDGED" });
    expect(next.status).toBe("idle");
  });

  it("idle + RETURN_TO_AUTODIAL is a no-op", () => {
    const next = autoDialReducer(IDLE, { type: "RETURN_TO_AUTODIAL" });
    expect(next.status).toBe("idle");
  });

  it("idle + RESERVATION_RECEIVED when paused also works", () => {
    const paused: AutoDialState = { status: "paused" };
    const now = new Date().toISOString();
    const next = autoDialReducer(paused, {
      type: "RESERVATION_RECEIVED",
      data: SAMPLE_RESERVATION,
      startedAt: now,
    });
    expect(next.status).toBe("reserved");
  });
});
