"use client";

import { api } from "@/lib/api";
import type { AgentStatus } from "@/lib/stores/agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PauseCode {
  code: string;
  label: string;
  billable?: boolean;
}

export interface AgentStateResponse {
  status: AgentStatus;
  pauseCode: string | null;
  pausedSince: number | null;
  currentCampaignId: number | null;
}

export interface SetAgentStatePayload {
  status: AgentStatus;
  pauseCode?: string | null;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * GET /api/agent/state
 * Returns the server-authoritative agent state for the current user.
 */
export async function getAgentState(): Promise<AgentStateResponse> {
  return api.get<AgentStateResponse>("/api/agent/state");
}

/**
 * POST /api/agent/state
 * Transitions the agent state on the server. Returns the confirmed state.
 * Callers should apply an optimistic update and rollback on error.
 */
export async function setAgentState(
  payload: SetAgentStatePayload,
): Promise<AgentStateResponse> {
  return api.post<AgentStateResponse>("/api/agent/state", payload);
}

/**
 * GET /api/agent/pause-codes
 * Returns available pause codes for the agent's tenant.
 */
export async function getPauseCodes(): Promise<PauseCode[]> {
  return api.get<PauseCode[]>("/api/agent/pause-codes");
}
