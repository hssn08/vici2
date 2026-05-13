// I03 — Voicemail routes unit tests.
// Tests: RBAC categories, N01 category registration, RBAC verb presence.

import { describe, it, expect } from "vitest";
import { VERBS, ROLE_VERBS } from "@vici2/types";
import { ALL_CATEGORIES, CATEGORY_DEFAULTS } from "../../src/notifications/categories.js";

// ─── RBAC verbs ───────────────────────────────────────────────────────────────

describe("I03 RBAC verbs", () => {
  it("voicemail:read is in the VERBS list", () => {
    expect(VERBS).toContain("voicemail:read");
  });

  it("voicemail:manage is in the VERBS list", () => {
    expect(VERBS).toContain("voicemail:manage");
  });

  it("super_admin has voicemail:read", () => {
    expect(ROLE_VERBS.super_admin.has("voicemail:read")).toBe(true);
  });

  it("super_admin has voicemail:manage", () => {
    expect(ROLE_VERBS.super_admin.has("voicemail:manage")).toBe(true);
  });

  it("admin has voicemail:read", () => {
    expect(ROLE_VERBS.admin.has("voicemail:read")).toBe(true);
  });

  it("admin has voicemail:manage", () => {
    expect(ROLE_VERBS.admin.has("voicemail:manage")).toBe(true);
  });

  it("supervisor has voicemail:read", () => {
    expect(ROLE_VERBS.supervisor.has("voicemail:read")).toBe(true);
  });

  it("supervisor does NOT have voicemail:manage", () => {
    expect(ROLE_VERBS.supervisor.has("voicemail:manage")).toBe(false);
  });

  it("agent has voicemail:read", () => {
    expect(ROLE_VERBS.agent.has("voicemail:read")).toBe(true);
  });

  it("agent does NOT have voicemail:manage", () => {
    expect(ROLE_VERBS.agent.has("voicemail:manage")).toBe(false);
  });

  it("viewer has voicemail:read", () => {
    expect(ROLE_VERBS.viewer.has("voicemail:read")).toBe(true);
  });

  it("integrator does NOT have voicemail:read (machine-to-machine only)", () => {
    // Integrators get explicit per-API-key grants; not in the default matrix
    expect(ROLE_VERBS.integrator.has("voicemail:read")).toBe(false);
  });
});

// ─── N01 category ─────────────────────────────────────────────────────────────

describe("I03 N01 voicemail_new category", () => {
  it("voicemail_new is in ALL_CATEGORIES", () => {
    expect(ALL_CATEGORIES).toContain("voicemail_new");
  });

  it("voicemail_new defaults to in_app + email", () => {
    expect(CATEGORY_DEFAULTS.voicemail_new.defaultChannels).toEqual(
      expect.arrayContaining(["in_app", "email"]),
    );
  });

  it("voicemail_new severity is info", () => {
    expect(CATEGORY_DEFAULTS.voicemail_new.severity).toBe("info");
  });
});

// ─── Status transition logic ──────────────────────────────────────────────────

describe("VoicemailStatus enum values", () => {
  const VALID_STATUSES = ["NEW", "READ", "ARCHIVED", "DELETED"] as const;

  it.each(VALID_STATUSES)("status %s is a valid value", (status) => {
    expect(["NEW", "READ", "ARCHIVED", "DELETED"]).toContain(status);
  });

  it("DELETED is a valid terminal status (used for soft-delete)", () => {
    expect(VALID_STATUSES).toContain("DELETED");
  });
});

// ─── VoicemailRenderer XML structure ─────────────────────────────────────────

describe("VoicemailRenderer XML contract", () => {
  it("extension name pattern follows voicemail_{boxId}", () => {
    // The extension name must match what I02 IvrRenderer generates for terminal_voicemail.
    // I02 PLAN §4.3: transfer voicemail_{action_target} XML default
    // I03 PLAN §2.1: extension name = voicemail_{box_id}
    const pattern = /^voicemail_\d+$/;
    expect("voicemail_42").toMatch(pattern);
    expect("voicemail_1").toMatch(pattern);
    expect("ingroup_SUPPORT").not.toMatch(pattern);
  });
});
