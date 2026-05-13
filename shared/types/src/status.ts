// D04 — Status type definitions (pure TS, no external deps).
// Exported via @vici2/types.
// Zod validators live in api/src/statuses/validators.ts.

// ── Core types ─────────────────────────────────────────────────────────────────

export interface EffectiveStatus {
  code: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  /** -1=terminal, 0=immediate, null=campaign default, >0=seconds */
  recycleDelaySeconds: number | null;
  maxCalls: number | null;
  category: string | null;
  systemOwner: string | null;
  /** Which merge layer this row came from */
  source: "shadow" | "override" | "system";
}

export interface StatusDef {
  description?: string;
  selectable?: boolean;
  humanAnswered?: boolean;
  sale?: boolean;
  dnc?: boolean;
  callback?: boolean;
  notInterested?: boolean;
  hotkey?: string | null;
  recycleDelaySeconds?: number | null;
  maxCalls?: number | null;
  category?: string | null;
  systemOwner?: string | null;
}

export interface TransitionResult {
  allowed: boolean;
  errorCode?: string;
  reason?: string;
}
