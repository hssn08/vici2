// S05 — Coaching service shared types.

export type CriterionType = 'numeric' | 'binary' | 'auto_fail' | 'text_only';

export interface ScorecardCriterion {
  id: string;            // uuid
  label: string;
  type: CriterionType;
  weight: number;        // 0..100; must sum to 100 (excluding text_only + auto_fail)
  max_score: number;     // ≥1 for numeric/binary; 0 for text_only
  section?: string;
  auto_fail?: boolean;   // if true, type must be 'auto_fail'
  na_eligible?: boolean;
}

export interface ScoreEntry {
  criterion_id: string;
  score: number;
  na?: boolean;
  comment?: string;
}

export interface ScorecardCriteriaValidationError {
  field: string;
  message: string;
}
