/**
 * A02 — RTCStatsReport polling → SoftphoneStats.
 *
 * Polls peerConnection.getStats() every statsIntervalMs (default 5000 ms).
 * Extracts jitter, packet loss, RTT, and audio level from standard
 * WebRTC stats reports.
 *
 * Thresholds (warn / alert):
 *   jitter:      > 30 ms / > 50 ms
 *   packet loss: > 2% / > 5%
 *   RTT:         > 250 ms / > 500 ms
 */

import type { SoftphoneStats } from "./types";

export interface StatsThresholdFlags {
  jitterWarn: boolean;
  jitterAlert: boolean;
  lossWarn: boolean;
  lossAlert: boolean;
  rttWarn: boolean;
  rttAlert: boolean;
  deadMic: boolean;
}

interface ParsedStats {
  stats: SoftphoneStats;
  flags: StatsThresholdFlags;
}

/** Previous inbound-rtp counters for delta-based packet loss. */
interface RtpCounters {
  packetsReceived: number;
  packetsLost: number;
}

let prevCounters: RtpCounters | null = null;

/**
 * Parse an RTCStatsReport into SoftphoneStats + threshold flags.
 * Exported for unit testing.
 */
export function parseStatsReport(report: RTCStatsReport): ParsedStats {
  let jitterMs = 0;
  let packetLossPct = 0;
  let rttMs = 0;
  let audioLevel = 0;

  for (const entry of report.values()) {
    if (entry.type === "inbound-rtp" && entry.kind === "audio") {
      jitterMs = (entry.jitter ?? 0) * 1000;
      audioLevel = entry.audioLevel ?? 0;

      const received: number = entry.packetsReceived ?? 0;
      const lost: number = entry.packetsLost ?? 0;
      if (prevCounters) {
        const deltaReceived = Math.max(0, received - prevCounters.packetsReceived);
        const deltaLost = Math.max(0, lost - prevCounters.packetsLost);
        const total = deltaReceived + deltaLost;
        packetLossPct = total > 0 ? (deltaLost / total) * 100 : 0;
      }
      prevCounters = { packetsReceived: received, packetsLost: lost };
    }

    if (entry.type === "remote-inbound-rtp" && entry.kind === "audio") {
      rttMs = (entry.roundTripTime ?? 0) * 1000;
    }
  }

  const stats: SoftphoneStats = { jitterMs, packetLossPct, rttMs, audioLevel };
  const flags: StatsThresholdFlags = {
    jitterWarn: jitterMs > 30,
    jitterAlert: jitterMs > 50,
    lossWarn: packetLossPct > 2,
    lossAlert: packetLossPct > 5,
    rttWarn: rttMs > 250,
    rttAlert: rttMs > 500,
    deadMic: audioLevel < 0.001,
  };

  return { stats, flags };
}

/** Reset inter-call delta counters. */
export function resetStatsCounters(): void {
  prevCounters = null;
}

export type StatsCallback = (stats: SoftphoneStats, flags: StatsThresholdFlags) => void;

/**
 * Start polling getStats on the given peer connection.
 * Returns a cleanup function that stops polling.
 */
export function startStatsPoller(
  getPeerConnection: () => RTCPeerConnection | null,
  onStats: StatsCallback,
  intervalMs = 5000,
): () => void {
  let timerId: ReturnType<typeof setInterval> | null = null;

  timerId = setInterval(async () => {
    const pc = getPeerConnection();
    if (!pc) return;
    try {
      const report = await pc.getStats();
      const { stats, flags } = parseStatsReport(report);
      onStats(stats, flags);
    } catch {
      // getStats can fail if PC is closing; ignore
    }
  }, intervalMs);

  return () => {
    if (timerId !== null) clearInterval(timerId);
  };
}
