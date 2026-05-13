/**
 * A02 unit tests — stats.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseStatsReport, resetStatsCounters } from "@/lib/sip/stats";

// Helper to build a mock RTCStatsReport
function buildReport(
  entries: { type: string; kind?: string; [k: string]: unknown }[],
): RTCStatsReport {
  const map = new Map<string, unknown>(
    entries.map((e, i) => [`id-${i}`, e]),
  );
  return map as unknown as RTCStatsReport;
}

describe("parseStatsReport", () => {
  beforeEach(() => {
    resetStatsCounters();
  });

  it("extracts jitter from inbound-rtp", () => {
    const report = buildReport([
      {
        type: "inbound-rtp",
        kind: "audio",
        jitter: 0.04, // 40ms
        audioLevel: 0.5,
        packetsReceived: 100,
        packetsLost: 0,
      },
    ]);

    const { stats } = parseStatsReport(report);
    expect(stats.jitterMs).toBeCloseTo(40);
    expect(stats.audioLevel).toBe(0.5);
  });

  it("extracts RTT from remote-inbound-rtp", () => {
    const report = buildReport([
      {
        type: "remote-inbound-rtp",
        kind: "audio",
        roundTripTime: 0.3, // 300ms
      },
    ]);

    const { stats } = parseStatsReport(report);
    expect(stats.rttMs).toBeCloseTo(300);
  });

  it("flags jitter warn at >30ms", () => {
    const report = buildReport([
      {
        type: "inbound-rtp",
        kind: "audio",
        jitter: 0.035,
        packetsReceived: 100,
        packetsLost: 0,
        audioLevel: 0.1,
      },
    ]);

    const { flags } = parseStatsReport(report);
    expect(flags.jitterWarn).toBe(true);
    expect(flags.jitterAlert).toBe(false);
  });

  it("flags jitter alert at >50ms", () => {
    const report = buildReport([
      {
        type: "inbound-rtp",
        kind: "audio",
        jitter: 0.06,
        packetsReceived: 100,
        packetsLost: 0,
        audioLevel: 0.1,
      },
    ]);

    const { flags } = parseStatsReport(report);
    expect(flags.jitterAlert).toBe(true);
  });

  it("flags rttWarn at >250ms", () => {
    const report = buildReport([
      {
        type: "remote-inbound-rtp",
        kind: "audio",
        roundTripTime: 0.3,
      },
    ]);

    const { flags } = parseStatsReport(report);
    expect(flags.rttWarn).toBe(true);
    expect(flags.rttAlert).toBe(false);
  });

  it("flags rttAlert at >500ms", () => {
    const report = buildReport([
      {
        type: "remote-inbound-rtp",
        kind: "audio",
        roundTripTime: 0.6,
      },
    ]);

    const { flags } = parseStatsReport(report);
    expect(flags.rttAlert).toBe(true);
  });

  it("detects dead mic when audioLevel near 0", () => {
    const report = buildReport([
      {
        type: "inbound-rtp",
        kind: "audio",
        jitter: 0,
        audioLevel: 0.0001,
        packetsReceived: 50,
        packetsLost: 0,
      },
    ]);

    const { flags } = parseStatsReport(report);
    expect(flags.deadMic).toBe(true);
  });

  it("returns zeros for empty report", () => {
    const report = buildReport([]);
    const { stats } = parseStatsReport(report);
    expect(stats.jitterMs).toBe(0);
    expect(stats.packetLossPct).toBe(0);
    expect(stats.rttMs).toBe(0);
    expect(stats.audioLevel).toBe(0);
  });
});
