import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAgentState, setAgentState, getPauseCodes } from "@/lib/agent/api";

// ---------------------------------------------------------------------------
// Mock @/lib/api
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAgentState", () => {
    it("calls GET /api/agent/state", async () => {
      const response = {
        status: "ready",
        pauseCode: null,
        pausedSince: null,
        currentCampaignId: null,
      };
      mockGet.mockResolvedValue(response);

      const result = await getAgentState();
      expect(mockGet).toHaveBeenCalledWith("/api/agent/state");
      expect(result).toEqual(response);
    });
  });

  describe("setAgentState", () => {
    it("calls POST /api/agent/state with status", async () => {
      const payload = { status: "ready" as const };
      const response = {
        status: "ready",
        pauseCode: null,
        pausedSince: null,
        currentCampaignId: null,
      };
      mockPost.mockResolvedValue(response);

      const result = await setAgentState(payload);
      expect(mockPost).toHaveBeenCalledWith("/api/agent/state", payload);
      expect(result.status).toBe("ready");
    });

    it("calls POST /api/agent/state with status + pauseCode", async () => {
      const payload = { status: "paused" as const, pauseCode: "LUNCH" };
      mockPost.mockResolvedValue({
        status: "paused",
        pauseCode: "LUNCH",
        pausedSince: Date.now(),
        currentCampaignId: null,
      });

      await setAgentState(payload);
      expect(mockPost).toHaveBeenCalledWith("/api/agent/state", payload);
    });

    it("propagates API errors", async () => {
      mockPost.mockRejectedValue(new Error("Network error"));
      await expect(setAgentState({ status: "ready" })).rejects.toThrow(
        "Network error",
      );
    });
  });

  describe("getPauseCodes", () => {
    it("calls GET /api/agent/pause-codes", async () => {
      const codes = [
        { code: "LUNCH", label: "Lunch Break" },
        { code: "TRAIN", label: "Training", billable: true },
      ];
      mockGet.mockResolvedValue(codes);

      const result = await getPauseCodes();
      expect(mockGet).toHaveBeenCalledWith("/api/agent/pause-codes");
      expect(result).toHaveLength(2);
      expect(result[0].code).toBe("LUNCH");
    });
  });
});
