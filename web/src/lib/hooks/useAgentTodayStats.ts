"use client";

/**
 * A07 — useAgentTodayStats
 * Fetches today's agent stats on mount and auto-refreshes every 30s.
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface AgentTodayStats {
  callsHandled: number;
  contacts: number;
  sales: number;
  talkTimeSec: number;
  dropPct: number;
  asOf: string;
}

const REFRESH_INTERVAL_MS = 30_000;

export function useAgentTodayStats() {
  const [stats, setStats] = useState<AgentTodayStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<AgentTodayStats>("/api/agent/stats/today");
      setStats(data);
    } catch (err) {
      console.error("[agent-stats] fetch failed", err);
      setError("Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch();
    const id = setInterval(() => void fetch(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetch]);

  return { stats, loading, error, refresh: fetch };
}
