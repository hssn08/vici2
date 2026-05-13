// D04 — hangup-cause map unit tests.
// All 28 entries + unknown-fallback + unmapped metric.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock metrics ──────────────────────────────────────────────────────────────
vi.mock("../../src/statuses/metrics.js", () => ({
  hangupUnmappedTotal: { inc: vi.fn() },
  hangupResolutionsTotal: { inc: vi.fn() },
  cacheOpsTotal: { inc: vi.fn() },
  dispositionWritesTotal: { inc: vi.fn() },
  dispositionWriteLatencyMs: { observe: vi.fn() },
  dncSideEffectTotal: { inc: vi.fn() },
  crmWebhookTotal: { inc: vi.fn() },
  terminalRecycleWritesTotal: { inc: vi.fn() },
  illegalTransitionTotal: { inc: vi.fn() },
  d04Registry: {},
}));

import { resolveFromHangupCause, loadHangupMap, getHangupMap } from "../../src/statuses/hangup-map.js";
import { hangupUnmappedTotal, hangupResolutionsTotal } from "../../src/statuses/metrics.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = <worktree>/api/test/statuses → 3 levels up = <worktree>/
const SEED_FILE = join(__dirname, "..", "..", "..", "db", "seeds", "hangup-cause-map.json");

describe("hangup-cause map", () => {
  beforeEach(() => {
    // Load from seed file for each test
    loadHangupMap(SEED_FILE);
    vi.clearAllMocks();
  });

  it("has exactly 28 entries in hangup-cause-map.json", () => {
    const raw = JSON.parse(readFileSync(SEED_FILE, "utf8")) as Record<string, string>;
    expect(Object.keys(raw)).toHaveLength(28);
  });

  it("resolves USER_BUSY → B-CAR", () => {
    expect(resolveFromHangupCause("USER_BUSY")).toBe("B-CAR");
  });

  it("resolves NO_ANSWER → NA-CAR", () => {
    expect(resolveFromHangupCause("NO_ANSWER")).toBe("NA-CAR");
  });

  it("resolves NO_USER_RESPONSE → NA-CAR", () => {
    expect(resolveFromHangupCause("NO_USER_RESPONSE")).toBe("NA-CAR");
  });

  it("resolves CALL_REJECTED → B-CAR", () => {
    expect(resolveFromHangupCause("CALL_REJECTED")).toBe("B-CAR");
  });

  it("resolves ORIGINATOR_CANCEL → ERI", () => {
    expect(resolveFromHangupCause("ORIGINATOR_CANCEL")).toBe("ERI");
  });

  it("resolves MEDIA_TIMEOUT → MEDIA_TO", () => {
    expect(resolveFromHangupCause("MEDIA_TIMEOUT")).toBe("MEDIA_TO");
  });

  it("resolves UNALLOCATED_NUMBER → INVALID", () => {
    expect(resolveFromHangupCause("UNALLOCATED_NUMBER")).toBe("INVALID");
  });

  it("resolves INVALID_NUMBER_FORMAT → INVALID", () => {
    expect(resolveFromHangupCause("INVALID_NUMBER_FORMAT")).toBe("INVALID");
  });

  it("resolves RECOVERY_ON_TIMER_EXPIRE → TIMEOT", () => {
    expect(resolveFromHangupCause("RECOVERY_ON_TIMER_EXPIRE")).toBe("TIMEOT");
  });

  it("resolves NORMAL_TEMPORARY_FAILURE → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("NORMAL_TEMPORARY_FAILURE")).toBe("CARRIER_FAIL");
  });

  it("resolves NETWORK_OUT_OF_ORDER → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("NETWORK_OUT_OF_ORDER")).toBe("CARRIER_FAIL");
  });

  it("resolves USER_NOT_REGISTERED → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("USER_NOT_REGISTERED")).toBe("CARRIER_FAIL");
  });

  it("resolves GATEWAY_DOWN → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("GATEWAY_DOWN")).toBe("CARRIER_FAIL");
  });

  it("resolves EXCHANGE_ROUTING_ERROR → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("EXCHANGE_ROUTING_ERROR")).toBe("CARRIER_FAIL");
  });

  it("resolves DESTINATION_OUT_OF_ORDER → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("DESTINATION_OUT_OF_ORDER")).toBe("CARRIER_FAIL");
  });

  it("resolves RESPONSE_TO_STATUS_ENQUIRY → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("RESPONSE_TO_STATUS_ENQUIRY")).toBe("CARRIER_FAIL");
  });

  it("resolves NETWORK_CONGESTION → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("NETWORK_CONGESTION")).toBe("CARRIER_FAIL");
  });

  it("resolves ACCESS_INFO_DISCARDED → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("ACCESS_INFO_DISCARDED")).toBe("CARRIER_FAIL");
  });

  it("resolves REQUESTED_CHAN_UNAVAIL → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("REQUESTED_CHAN_UNAVAIL")).toBe("CARRIER_FAIL");
  });

  it("resolves INCOMING_CALL_BARRED → INVALID", () => {
    expect(resolveFromHangupCause("INCOMING_CALL_BARRED")).toBe("INVALID");
  });

  it("resolves BEARERCAPABILITY_NOTAUTH → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("BEARERCAPABILITY_NOTAUTH")).toBe("CARRIER_FAIL");
  });

  it("resolves BEARERCAPABILITY_NOTAVAIL → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("BEARERCAPABILITY_NOTAVAIL")).toBe("CARRIER_FAIL");
  });

  it("resolves SERVICE_UNAVAILABLE → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("SERVICE_UNAVAILABLE")).toBe("CARRIER_FAIL");
  });

  it("resolves INTERWORKING → CARRIER_FAIL", () => {
    expect(resolveFromHangupCause("INTERWORKING")).toBe("CARRIER_FAIL");
  });

  it("resolves MANAGER_REQUEST → ERI", () => {
    expect(resolveFromHangupCause("MANAGER_REQUEST")).toBe("ERI");
  });

  it("resolves NORMAL_UNSPECIFIED → NA-CAR", () => {
    expect(resolveFromHangupCause("NORMAL_UNSPECIFIED")).toBe("NA-CAR");
  });

  it("resolves NORMAL_CLEARING → NA-CAR", () => {
    expect(resolveFromHangupCause("NORMAL_CLEARING")).toBe("NA-CAR");
  });

  it("unknown cause → NA + increments hangupUnmappedTotal", () => {
    const result = resolveFromHangupCause("UNKNOWN_CAUSE_XYZ");
    expect(result).toBe("NA");
    expect((hangupUnmappedTotal.inc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ cause: "UNKNOWN_CAUSE_XYZ" });
    expect((hangupResolutionsTotal.inc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ cause: "UNKNOWN_CAUSE_XYZ", status: "NA" });
  });

  it("getHangupMap returns full map for admin inspection", () => {
    const map = getHangupMap();
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(28);
    expect(map["USER_BUSY"]).toBe("B-CAR");
  });
});
