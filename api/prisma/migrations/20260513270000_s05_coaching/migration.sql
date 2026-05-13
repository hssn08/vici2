-- S05 — Supervisor Coaching Tools migration
-- Adds: scorecard_templates, call_scorecards, call_annotations, agent_feedback,
--       scorecard_calibration_sessions, scorecard_calibration_assignments
-- Branch: feat/S05-implement
-- Date: 2026-05-13

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. scorecard_templates
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE scorecard_templates (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  parent_id     BIGINT UNSIGNED  NULL
                COMMENT 'NULL = root version; set when template is versioned',
  version       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  name          VARCHAR(128)     NOT NULL,
  description   TEXT             NULL,
  criteria      JSON             NOT NULL
                COMMENT 'Array of ScorecardCriterion',
  active        TINYINT(1)       NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED  NULL,
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                 ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_sct_tenant  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_sct_creator FOREIGN KEY (created_by) REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT fk_sct_parent  FOREIGN KEY (parent_id)  REFERENCES scorecard_templates(id) ON DELETE SET NULL,
  KEY idx_sct_t_active (tenant_id, active, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. call_scorecards
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE call_scorecards (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  call_uuid      VARCHAR(40)      NOT NULL,
  template_id    BIGINT UNSIGNED  NOT NULL,
  supervisor_id  BIGINT UNSIGNED  NULL
                 COMMENT 'NULL if deleted user',
  agent_id       BIGINT UNSIGNED  NULL
                 COMMENT 'NULL if call had no agent (edge case)',
  campaign_id    VARCHAR(32)      NULL,
  scores         JSON             NOT NULL
                 COMMENT 'Array of {criterion_id, score, na: bool, comment}',
  total_score    DECIMAL(5,2)     NOT NULL DEFAULT 0.00
                 COMMENT '0..100, computed on save',
  comments       TEXT             NULL
                 COMMENT 'Overall evaluation comment',
  status         ENUM('draft','finalized') NOT NULL DEFAULT 'draft',
  is_calibration TINYINT(1)       NOT NULL DEFAULT 0,
  finalized_at   DATETIME(6)      NULL,
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_cs_tenant     FOREIGN KEY (tenant_id)    REFERENCES tenants(id)             ON DELETE CASCADE,
  CONSTRAINT fk_cs_template   FOREIGN KEY (template_id)  REFERENCES scorecard_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cs_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)              ON DELETE SET NULL,
  CONSTRAINT fk_cs_agent      FOREIGN KEY (agent_id)     REFERENCES users(id)               ON DELETE SET NULL,
  KEY idx_cs_t_agent      (tenant_id, agent_id, created_at),
  KEY idx_cs_t_template   (tenant_id, template_id, status, created_at),
  KEY idx_cs_t_call_uuid  (tenant_id, call_uuid),
  KEY idx_cs_t_supervisor (tenant_id, supervisor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. call_annotations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE call_annotations (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  call_uuid      VARCHAR(40)      NOT NULL,
  scorecard_id   BIGINT UNSIGNED  NULL
                 COMMENT 'NULL if standalone annotation not linked to a scorecard',
  supervisor_id  BIGINT UNSIGNED  NULL,
  timestamp_ms   INT UNSIGNED     NOT NULL
                 COMMENT 'Milliseconds from call start (synced with audio player)',
  text           TEXT             NOT NULL,
  tag            ENUM('positive','needs_improvement','training_opportunity','compliance_flag','praise')
                 NOT NULL DEFAULT 'needs_improvement',
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_ca_tenant     FOREIGN KEY (tenant_id)    REFERENCES tenants(id)         ON DELETE CASCADE,
  CONSTRAINT fk_ca_scorecard  FOREIGN KEY (scorecard_id) REFERENCES call_scorecards(id) ON DELETE SET NULL,
  CONSTRAINT fk_ca_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)          ON DELETE SET NULL,
  KEY idx_ca_t_call    (tenant_id, call_uuid, timestamp_ms),
  KEY idx_ca_scorecard (scorecard_id, timestamp_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. agent_feedback
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE agent_feedback (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id            BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  agent_id             BIGINT UNSIGNED  NOT NULL,
  supervisor_id        BIGINT UNSIGNED  NULL,
  related_scorecard_id BIGINT UNSIGNED  NULL,
  related_call_uuid    VARCHAR(40)      NULL,
  body                 TEXT             NOT NULL,
  acknowledged_at      DATETIME(6)      NULL
                       COMMENT 'NULL until agent clicks Acknowledge; immutable once set',
  created_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                        ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_af_tenant     FOREIGN KEY (tenant_id)             REFERENCES tenants(id)         ON DELETE CASCADE,
  CONSTRAINT fk_af_agent      FOREIGN KEY (agent_id)              REFERENCES users(id)           ON DELETE CASCADE,
  CONSTRAINT fk_af_supervisor FOREIGN KEY (supervisor_id)         REFERENCES users(id)           ON DELETE SET NULL,
  CONSTRAINT fk_af_scorecard  FOREIGN KEY (related_scorecard_id)  REFERENCES call_scorecards(id) ON DELETE SET NULL,
  KEY idx_af_t_agent      (tenant_id, agent_id, created_at),
  KEY idx_af_t_supervisor (tenant_id, supervisor_id, created_at),
  KEY idx_af_t_unack      (tenant_id, agent_id, acknowledged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. scorecard_calibration_sessions (Phase 2 scaffold — no app logic in Phase 1)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE scorecard_calibration_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    BIGINT UNSIGNED NOT NULL DEFAULT 1,
  name         VARCHAR(128)    NOT NULL,
  template_id  BIGINT UNSIGNED NOT NULL,
  moderator_id BIGINT UNSIGNED NULL,
  deadline_at  DATETIME(6)     NULL,
  status       ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at   DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_calib_t (tenant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. scorecard_calibration_assignments (Phase 2 scaffold)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE scorecard_calibration_assignments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id    BIGINT UNSIGNED NOT NULL,
  call_uuid     VARCHAR(40)     NOT NULL,
  evaluator_id  BIGINT UNSIGNED NULL,
  scorecard_id  BIGINT UNSIGNED NULL
                COMMENT 'Set once evaluator submits',
  created_at    DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_calib_assign_session (session_id, call_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
