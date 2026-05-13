// S05 — Shared coaching component types

export type CriterionType = 'numeric' | 'binary' | 'auto_fail' | 'text_only';
export type AnnotationTag = 'positive' | 'needs_improvement' | 'training_opportunity' | 'compliance_flag' | 'praise';
export type ScorecardStatus = 'draft' | 'finalized';

export interface ScorecardCriterion {
  id: string;
  label: string;
  type: CriterionType;
  weight: number;
  max_score: number;
  section?: string;
  auto_fail?: boolean;
  na_eligible?: boolean;
}

export interface ScoreEntry {
  criterion_id: string;
  score: number;
  na?: boolean;
  comment?: string;
}

export interface Annotation {
  id: string;
  call_uuid: string;
  scorecard_id?: string | null;
  supervisor_id?: string | null;
  timestamp_ms: number;
  text: string;
  tag: AnnotationTag;
  created_at: string;
  supervisor?: { id: string; full_name: string | null; username: string } | null;
}

export interface ScorecardTemplate {
  id: string;
  name: string;
  description?: string | null;
  version: number;
  criteria: ScorecardCriterion[];
  active: boolean;
}

export interface CallScorecard {
  id: string;
  call_uuid: string;
  template_id: string;
  supervisor_id?: string | null;
  agent_id?: string | null;
  scores: ScoreEntry[];
  total_score: string | number;
  comments?: string | null;
  status: ScorecardStatus;
  is_calibration: boolean;
  finalized_at?: string | null;
  template?: ScorecardTemplate;
  annotations?: Annotation[];
}

export interface AgentFeedback {
  id: string;
  agent_id: string;
  supervisor_id?: string | null;
  related_scorecard_id?: string | null;
  related_call_uuid?: string | null;
  body: string;
  acknowledged_at?: string | null;
  created_at: string;
  supervisor?: { id: string; full_name: string | null; username: string } | null;
  scorecard?: CallScorecard | null;
}

export const TAG_COLORS: Record<AnnotationTag, string> = {
  positive: '#22c55e',
  needs_improvement: '#f59e0b',
  training_opportunity: '#3b82f6',
  compliance_flag: '#ef4444',
  praise: '#10b981',
};

export const TAG_LABELS: Record<AnnotationTag, string> = {
  positive: 'Positive',
  needs_improvement: 'Needs Improvement',
  training_opportunity: 'Training Opportunity',
  compliance_flag: 'Compliance Flag',
  praise: 'Praise',
};
