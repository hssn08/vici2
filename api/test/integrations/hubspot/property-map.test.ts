import { describe, expect, it } from "vitest";
import { resolveCallStatus, DEFAULT_DISPOSITION_MAP } from "../../../src/integrations/hubspot/property-map.js";

describe("resolveCallStatus", () => {
  it("maps SALE to COMPLETED by default", () => {
    expect(resolveCallStatus("SALE")).toBe("COMPLETED");
  });

  it("maps NA to NO_ANSWER by default", () => {
    expect(resolveCallStatus("NA")).toBe("NO_ANSWER");
  });

  it("maps B to BUSY by default", () => {
    expect(resolveCallStatus("B")).toBe("BUSY");
  });

  it("maps AM to VOICEMAIL_LEFT by default", () => {
    expect(resolveCallStatus("AM")).toBe("VOICEMAIL_LEFT");
  });

  it("falls back to COMPLETED for unknown disposition", () => {
    expect(resolveCallStatus("UNKNOWN_DISPO_XYZ")).toBe("COMPLETED");
  });

  it("respects override map", () => {
    expect(resolveCallStatus("SALE", { SALE: "NO_ANSWER" })).toBe("NO_ANSWER");
  });

  it("ignores invalid override value (non-existent HS status)", () => {
    // Invalid hs status => falls back to default
    expect(resolveCallStatus("SALE", { SALE: "NOT_A_REAL_STATUS" })).toBe("COMPLETED");
  });

  it("all default disposition codes map to valid HS statuses", () => {
    const validStatuses = new Set([
      "COMPLETED", "CONNECTED", "NO_ANSWER", "BUSY", "FAILED",
      "CANCELED", "VOICEMAIL_LEFT", "CALLING_CRM_USER", "MISSED", "RINGING", "IN_PROGRESS",
    ]);
    for (const [dispo, status] of Object.entries(DEFAULT_DISPOSITION_MAP)) {
      expect(validStatuses.has(status), `${dispo} → ${status} is not a valid hs_call_status`).toBe(true);
    }
  });
});
