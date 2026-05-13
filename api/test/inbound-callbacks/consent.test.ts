// I04 — Unit tests for consent audit record builder.
// I04 PLAN §10.1 (TypeScript tests).

import { describe, it, expect } from "vitest";
import { buildConsentAuditRecord } from "../../src/inbound-callbacks/consent.js";

describe("buildConsentAuditRecord", () => {
  it("sets consent_mode to INBOUND_CALLBACK_REQUESTED", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(12345),
      originalIngroupId: "SUPPORT",
      originalWaitSeconds: 127,
      queuePositionAtOffer: 3,
      tcpaResult: { outcome: "ALLOW" },
    });
    expect(rec.consent_mode).toBe("INBOUND_CALLBACK_REQUESTED");
  });

  it("always sets skip_internal_dnc=true", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: null,
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "ALLOW" },
    });
    expect(rec.skip_internal_dnc).toBe(true);
  });

  it("always sets skip_national_dnc=false", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: null,
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "ALLOW" },
    });
    expect(rec.skip_national_dnc).toBe(false);
  });

  it("serialises callbackId as string", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(99001),
      originalIngroupId: "SUPPORT",
      originalWaitSeconds: 60,
      queuePositionAtOffer: 1,
      tcpaResult: { outcome: "ALLOW", ruleApplied: "fed_8_21" },
    });
    expect(rec.callback_id).toBe("99001");
  });

  it("propagates tcpa_outcome", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: "SALES",
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "SKIP_UNTIL" },
    });
    expect(rec.tcpa_outcome).toBe("SKIP_UNTIL");
  });

  it("propagates party_local_time as ISO string", () => {
    const when = new Date("2026-05-13T14:23:00.000Z");
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: null,
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "ALLOW", partyLocalTime: when },
    });
    expect(rec.party_local_time).toBe(when.toISOString());
  });

  it("sets party_local_time to null when not provided", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: null,
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "ALLOW" },
    });
    expect(rec.party_local_time).toBeNull();
  });

  it("handles null ingroup and wait seconds", () => {
    const rec = buildConsentAuditRecord({
      callbackId: BigInt(1),
      originalIngroupId: null,
      originalWaitSeconds: null,
      queuePositionAtOffer: null,
      tcpaResult: { outcome: "ALLOW" },
    });
    expect(rec.original_ingroup_id).toBeNull();
    expect(rec.original_wait_seconds).toBeNull();
    expect(rec.queue_position_at_offer).toBeNull();
  });
});
