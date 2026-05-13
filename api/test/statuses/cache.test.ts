// D04 — LRU cache unit tests.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/statuses/metrics.js", () => ({
  cacheOpsTotal: { inc: vi.fn() },
  hangupUnmappedTotal: { inc: vi.fn() },
  hangupResolutionsTotal: { inc: vi.fn() },
  dispositionWritesTotal: { inc: vi.fn() },
  dispositionWriteLatencyMs: { observe: vi.fn() },
  dncSideEffectTotal: { inc: vi.fn() },
  crmWebhookTotal: { inc: vi.fn() },
  terminalRecycleWritesTotal: { inc: vi.fn() },
  illegalTransitionTotal: { inc: vi.fn() },
  d04Registry: {},
}));

import { cacheGet, cacheSet, cacheInvalidate, cacheClear, publishInvalidation } from "../../src/statuses/cache.js";
import { cacheOpsTotal } from "../../src/statuses/metrics.js";
import type { EffectiveStatus } from "@vici2/types";

function makeStatus(code: string): EffectiveStatus {
  return {
    code,
    description: "Test",
    selectable: true,
    humanAnswered: false,
    sale: false,
    dnc: false,
    callback: false,
    notInterested: false,
    hotkey: null,
    recycleDelaySeconds: null,
    maxCalls: null,
    category: null,
    systemOwner: null,
    source: "system",
  };
}

describe("status cache", () => {
  beforeEach(() => {
    cacheClear();
    vi.clearAllMocks();
  });

  it("returns null on cache miss", () => {
    const result = cacheGet(1n, "CAMP1");
    expect(result).toBeNull();
    expect(cacheOpsTotal.inc).toHaveBeenCalledWith({ op: "miss" });
  });

  it("stores and retrieves data", () => {
    const data = [makeStatus("SALE"), makeStatus("NI")];
    cacheSet(1n, "CAMP1", data);
    const result = cacheGet(1n, "CAMP1");
    expect(result).toEqual(data);
    expect(cacheOpsTotal.inc).toHaveBeenCalledWith({ op: "hit" });
  });

  it("invalidates specific key", () => {
    const data = [makeStatus("SALE")];
    cacheSet(1n, "CAMP1", data);
    cacheInvalidate(1n, "CAMP1");
    expect(cacheGet(1n, "CAMP1")).toBeNull();
    expect(cacheOpsTotal.inc).toHaveBeenCalledWith({ op: "invalidate" });
  });

  it("different campaign IDs have separate cache entries", () => {
    const data1 = [makeStatus("SALE")];
    const data2 = [makeStatus("NI")];
    cacheSet(1n, "CAMP1", data1);
    cacheSet(1n, "CAMP2", data2);
    expect(cacheGet(1n, "CAMP1")).toEqual(data1);
    expect(cacheGet(1n, "CAMP2")).toEqual(data2);
  });

  it("different tenant IDs have separate cache entries", () => {
    const data1 = [makeStatus("SALE")];
    const data2 = [makeStatus("NI")];
    cacheSet(1n, "CAMP1", data1);
    cacheSet(2n, "CAMP1", data2);
    expect(cacheGet(1n, "CAMP1")).toEqual(data1);
    expect(cacheGet(2n, "CAMP1")).toEqual(data2);
  });

  it("publishInvalidation calls redis.publish and invalidates local cache", async () => {
    const data = [makeStatus("SALE")];
    cacheSet(1n, "CAMP1", data);

    const mockRedis = { publish: vi.fn().mockResolvedValue(1) };
    await publishInvalidation(mockRedis, 1n, "CAMP1");

    expect(mockRedis.publish).toHaveBeenCalledWith(
      "pubsub:t:1:status_changed:CAMP1",
      "1",
    );
    // Local cache should be invalidated
    expect(cacheGet(1n, "CAMP1")).toBeNull();
  });

  it("cacheClear clears all entries", () => {
    cacheSet(1n, "CAMP1", [makeStatus("SALE")]);
    cacheSet(2n, "CAMP2", [makeStatus("NI")]);
    cacheClear();
    expect(cacheGet(1n, "CAMP1")).toBeNull();
    expect(cacheGet(2n, "CAMP2")).toBeNull();
  });
});
