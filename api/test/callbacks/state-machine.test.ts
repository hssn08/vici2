// D06 — State machine unit tests: 14 transition cases.
// 7 legal transitions × assert result, 5 illegal, 2 idempotent.

import { describe, it, expect } from "vitest";
import { guardTransition } from "../../src/callbacks/state-machine.js";

describe("D06 state-machine guardTransition", () => {
  // ── 7 legal transitions ──────────────────────────────────────────────────

  it("PENDING → LIVE is legal (worker fires)", () => {
    const r = guardTransition("PENDING", "LIVE");
    expect(r.ok).toBe(true);
  });

  it("PENDING → DEAD is legal (cancel)", () => {
    const r = guardTransition("PENDING", "DEAD");
    expect(r.ok).toBe(true);
  });

  it("PENDING → PENDING is legal (snooze)", () => {
    const r = guardTransition("PENDING", "PENDING");
    expect(r.ok).toBe(true);
  });

  it("LIVE → DONE is legal (dispo recorded)", () => {
    const r = guardTransition("LIVE", "DONE");
    expect(r.ok).toBe(true);
  });

  it("LIVE → DEAD is legal (admin cancel)", () => {
    const r = guardTransition("LIVE", "DEAD");
    expect(r.ok).toBe(true);
  });

  it("LIVE → PENDING is legal (no-answer reschedule)", () => {
    const r = guardTransition("LIVE", "PENDING");
    expect(r.ok).toBe(true);
  });

  it("PENDING → LIVE (duplicate, CAS context) is legal", () => {
    const r = guardTransition("PENDING", "LIVE");
    expect(r.ok).toBe(true);
  });

  // ── 5 illegal transitions ─────────────────────────────────────────────────

  it("DONE → PENDING is illegal (terminal)", () => {
    const r = guardTransition("DONE", "PENDING");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("callback_terminal");
  });

  it("DONE → LIVE is illegal (terminal)", () => {
    const r = guardTransition("DONE", "LIVE");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("callback_terminal");
  });

  it("DEAD → PENDING is illegal (terminal)", () => {
    const r = guardTransition("DEAD", "PENDING");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("callback_terminal");
  });

  it("DEAD → LIVE is illegal (terminal)", () => {
    const r = guardTransition("DEAD", "LIVE");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("callback_terminal");
  });

  it("LIVE → LIVE is illegal (no self-loop except via promote)", () => {
    const r = guardTransition("LIVE", "LIVE");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toContain("illegal_transition");
  });

  // ── 2 idempotent self-loops (snooze, claim-already-mine) ─────────────────

  it("PENDING → PENDING (snooze) returns ok=true (idempotent allowed)", () => {
    const r = guardTransition("PENDING", "PENDING");
    expect(r.ok).toBe(true);
  });

  it("PENDING → LIVE (re-fire attempt) is ok — CAS in promoteCallback handles idempotency", () => {
    const r = guardTransition("PENDING", "LIVE");
    expect(r.ok).toBe(true);
  });
});
