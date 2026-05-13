// I02 — Shared IVR types used by api + web.

export type IvrPhase = "xml" | "ivrbridge";

export type IvrNodeType =
  | "collect"
  | "lang_select"
  | "terminal_ingroup"
  | "terminal_hangup"
  | "terminal_voicemail"
  | "terminal_transfer"
  | "terminal_callback";

export const TERMINAL_NODE_TYPES = new Set<IvrNodeType>([
  "terminal_ingroup",
  "terminal_hangup",
  "terminal_voicemail",
  "terminal_transfer",
  "terminal_callback",
]);

export type IvrOutcome = "digit" | "timeout" | "hangup" | "invalid" | "terminal";

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface IvrDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  entryNodeId: string | null;
  active: boolean;
  phase: IvrPhase;
  maxDepthValidated: number;
  createdAt: string;
  updatedAt: string;
}

export interface IvrNodeDto {
  id: string;
  tenantId: string;
  ivrId: string;
  name: string;
  nodeType: IvrNodeType;
  collectMin: number;
  collectMax: number;
  collectTerminators: string;
  timeoutMs: number;
  interDigitMs: number;
  invalidMax: number;
  actionTarget: string | null;
  positionX: number;
  positionY: number;
  edges: IvrEdgeDto[];
  prompts: IvrPromptDto[];
  createdAt: string;
  updatedAt: string;
}

export interface IvrEdgeDto {
  id: string;
  tenantId: string;
  ivrId: string;
  fromNodeId: string;
  onInput: string;
  toNodeId: string | null;
  label: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface IvrPromptDto {
  id: string;
  tenantId: string;
  nodeId: string;
  lang: string;
  fileUri: string;
  fileSizeBytes: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IvrDetailDto extends IvrDto {
  nodes: IvrNodeDto[];
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface IvrNodeAnalytics {
  nodeId: string;
  name: string;
  entryCount: number;
  dropOffCount: number;
  dropOffRate: number;
  digitDistribution: Record<string, number>;
  timeoutCount: number;
  avgDurationMs: number;
}

export interface IvrAnalyticsResponse {
  sessionCount: number;
  completionRate: number;
  nodes: IvrNodeAnalytics[];
}

// ─── Traversal log (from ESL bridge) ─────────────────────────────────────────

export interface IvrTraversalLogEntry {
  sessionUuid: string;
  ivrId: string;
  lang: string;
  path: string[];
  digits: string[];
  finalOutcome: IvrOutcome | string;
  totalDurationMs: number;
}
