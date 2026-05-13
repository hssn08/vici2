"use client";

import * as React from "react";
import { useAgentStore } from "@/lib/stores/agent";
import { useUiStore } from "@/lib/stores/ui";
import { getPauseCodes, setAgentState } from "./api";
import type { AgentStatus } from "@/lib/stores/agent";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PauseCodeOption {
  code: string;
  name: string;
  billable: boolean;
}

export interface PauseConfig {
  pauseCodesRequired: "OFF" | "OPTIONAL" | "FORCE";
  codes: PauseCodeOption[];
  loading: boolean;
  error: string | null;
}

export interface AgentStateResult {
  // Current state (from useAgentStore)
  status: AgentStatus;
  pauseCode: string | null;
  pausedSince: number | null;
  currentCampaignId: number | null;

  // Pause mode config (fetched + cached)
  pauseConfig: PauseConfig;

  // Transition state
  transitioning: boolean;

  // Actions
  pause: (code: string | null, freeText?: string | null) => Promise<void>;
  unpause: () => Promise<void>;
  refreshPauseConfig: () => void;
}

export class PauseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PauseValidationError";
  }
}

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000; // 60 seconds

interface PauseConfigCache {
  data: PauseConfig;
  fetchedAt: number;
  campaignId: number | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentState(): AgentStateResult {
  const status = useAgentStore((s) => s.status);
  const pauseCode = useAgentStore((s) => s.pauseCode);
  const pausedSince = useAgentStore((s) => s.pausedSince);
  const currentCampaignId = useAgentStore((s) => s.currentCampaignId);
  const setPause = useAgentStore((s) => s.setPause);
  const clearPause = useAgentStore((s) => s.clearPause);
  const setStatus = useAgentStore((s) => s.setStatus);

  const setLastUsedPauseCode = useUiStore((s) => s.setLastUsedPauseCode);

  const [pauseConfig, setPauseConfig] = React.useState<PauseConfig>({
    pauseCodesRequired: "OPTIONAL",
    codes: [],
    loading: false,
    error: null,
  });
  const [transitioning, setTransitioning] = React.useState(false);

  const cacheRef = React.useRef<PauseConfigCache | null>(null);
  const fetchingRef = React.useRef(false);

  // ---------------------------------------------------------------------------
  // Fetch pause codes (with cache)
  // ---------------------------------------------------------------------------

  const fetchPauseConfig = React.useCallback(
    async (force = false) => {
      const now = Date.now();
      const cache = cacheRef.current;

      // Use cached data if still fresh and same campaign
      if (
        !force &&
        cache &&
        cache.campaignId === currentCampaignId &&
        now - cache.fetchedAt < CACHE_TTL_MS
      ) {
        return;
      }

      if (fetchingRef.current) return;
      fetchingRef.current = true;

      setPauseConfig((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const result = await getPauseCodes();
        const newConfig: PauseConfig = {
          pauseCodesRequired: result.pauseCodesRequired,
          codes: result.codes,
          loading: false,
          error: null,
        };
        cacheRef.current = { data: newConfig, fetchedAt: Date.now(), campaignId: currentCampaignId };
        setPauseConfig(newConfig);
      } catch {
        setPauseConfig((prev) => ({
          ...prev,
          loading: false,
          error: "Failed to load pause codes",
        }));
      } finally {
        fetchingRef.current = false;
      }
    },
    [currentCampaignId],
  );

  // Fetch on mount and on campaign change
  React.useEffect(() => {
    if (status === "ready" || status === "paused" || status === "wrapup") {
      void fetchPauseConfig();
    }
  }, [currentCampaignId, status]);

  // Invalidate cache when campaign changes
  React.useEffect(() => {
    if (
      cacheRef.current &&
      cacheRef.current.campaignId !== currentCampaignId
    ) {
      cacheRef.current = null;
    }
  }, [currentCampaignId]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const pause = React.useCallback(
    async (code: string | null, freeText?: string | null): Promise<void> => {
      const { pauseCodesRequired, codes } = pauseConfig;

      // FORCE mode validation
      if (pauseCodesRequired === "FORCE") {
        if (!code) {
          throw new PauseValidationError(
            "A pause code is required. Please select a code.",
          );
        }
        const valid = codes.some((c) => c.code === code);
        if (!valid) {
          throw new PauseValidationError(
            `Pause code "${code}" is not valid for this campaign.`,
          );
        }
      }

      const prevStatus = useAgentStore.getState().status;
      const prevCode = useAgentStore.getState().pauseCode;

      // Optimistic update
      setPause(code ?? "");
      setTransitioning(true);

      try {
        await setAgentState({
          status: "paused",
          pauseCode: code,
          pauseReason: freeText ?? null,
        });
        // Persist last-used code
        if (code) {
          setLastUsedPauseCode(code);
        }
      } catch {
        // Rollback
        if (prevStatus === "paused") {
          setPause(prevCode ?? "");
        } else {
          setStatus(prevStatus);
        }
        throw new Error("Failed to pause. Please try again.");
      } finally {
        setTransitioning(false);
      }
    },
    [pauseConfig, setPause, setStatus, setLastUsedPauseCode],
  );

  const unpause = React.useCallback(async (): Promise<void> => {
    const prevCode = useAgentStore.getState().pauseCode;

    // Optimistic update
    clearPause();
    setTransitioning(true);

    try {
      await setAgentState({ status: "ready" });
    } catch {
      // Rollback
      setPause(prevCode ?? "");
      throw new Error("Failed to go ready. Please try again.");
    } finally {
      setTransitioning(false);
    }
  }, [clearPause, setPause]);

  const refreshPauseConfig = React.useCallback(() => {
    void fetchPauseConfig(true);
  }, [fetchPauseConfig]);

  return {
    status,
    pauseCode,
    pausedSince,
    currentCampaignId,
    pauseConfig,
    transitioning,
    pause,
    unpause,
    refreshPauseConfig,
  };
}
