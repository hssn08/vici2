-- I01 migration: inbound in-groups + skill routing.
-- I01 PLAN §3 — 4 new tables + 2 additive ALTERs.
-- All reversible (see down.sql).

-- =============================================================================
-- 3.1  ingroup_skills — per-in-group skill requirements
-- =============================================================================

CREATE TABLE ingroup_skills (
  tenant_id        BIGINT       NOT NULL DEFAULT 1,
  ingroup_id       VARCHAR(32)  NOT NULL,
  skill_key        VARCHAR(32)  NOT NULL,
  skill_value      VARCHAR(32)  NOT NULL,
  min_proficiency  TINYINT UNSIGNED NOT NULL DEFAULT 1,
  required         TINYINT(1)   NOT NULL DEFAULT 1,
  weight           SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  created_at       DATETIME(6)  DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6)  DEFAULT CURRENT_TIMESTAMP(6)
                               ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, ingroup_id, skill_key, skill_value),
  INDEX idx_igs_t_skill (tenant_id, skill_key, skill_value),
  CONSTRAINT fk_igs_ingroup FOREIGN KEY (tenant_id, ingroup_id)
    REFERENCES ingroups(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- 3.2  agent_skills — per-agent skill proficiency
-- =============================================================================

CREATE TABLE agent_skills (
  tenant_id      BIGINT          NOT NULL DEFAULT 1,
  user_id        BIGINT          NOT NULL,
  skill_key      VARCHAR(32)     NOT NULL,
  skill_value    VARCHAR(32)     NOT NULL,
  proficiency    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  certified_at   DATE,
  expires_at     DATE,
  active         TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME(6)     DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)     DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, user_id, skill_key, skill_value),
  INDEX idx_as_t_skill (tenant_id, skill_key, skill_value, proficiency),
  CONSTRAINT fk_as_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- 3.3  queue_calls — inbound call audit (partitioned monthly)
-- =============================================================================

CREATE TABLE queue_calls (
  id               BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id        BIGINT        NOT NULL DEFAULT 1,
  call_uuid        VARCHAR(40)   NOT NULL,
  ingroup_id       VARCHAR(32)   NOT NULL,
  did_e164         VARCHAR(16),
  caller_id_e164   VARCHAR(16),
  lead_id          BIGINT,
  enter_at         DATETIME(6)   NOT NULL,
  base_score       BIGINT        NOT NULL,
  matched_skills   JSON,
  dispatch_at      DATETIME(6),
  dispatch_user_id BIGINT,
  exit_at          DATETIME(6),
  exit_reason      ENUM(
    'answered','caller_hangup','timeout','overflow',
    'callback','full_at_entry','agent_no_answer'
  ),
  position_at_entry INT,
  wait_seconds     INT,
  recording_uuid   VARCHAR(40),
  created_at       DATETIME(6)  DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id, enter_at),
  INDEX idx_qc_t_ingroup_enter (tenant_id, ingroup_id, enter_at),
  INDEX idx_qc_t_exit          (tenant_id, exit_at, exit_reason),
  INDEX idx_qc_t_lead          (tenant_id, lead_id),
  INDEX idx_qc_t_uuid          (tenant_id, call_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE (TO_DAYS(enter_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
);

-- =============================================================================
-- 3.4  queue_log — per-event audit (partitioned monthly)
-- =============================================================================

CREATE TABLE queue_log (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT       NOT NULL DEFAULT 1,
  queue_call_id  BIGINT       NOT NULL,
  event_at       DATETIME(6)  NOT NULL,
  event          ENUM(
    'enter','position_announce','offer_callback','accept_callback',
    'sticky_attempt','dispatch','agent_no_answer','reroute',
    'overflow','answer','caller_hangup','timeout','full_block'
  ) NOT NULL,
  metadata       JSON,
  PRIMARY KEY (id, event_at),
  INDEX idx_ql_t_qc    (tenant_id, queue_call_id, event_at),
  INDEX idx_ql_t_event (tenant_id, event, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE (TO_DAYS(event_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
);

-- =============================================================================
-- 3.5  Additive ALTER on did_numbers (I01 PLAN §3.5)
-- =============================================================================

ALTER TABLE did_numbers
  ADD COLUMN priority_boost_seconds INT NOT NULL DEFAULT 0
    COMMENT 'VIP head-start seconds subtracted from ZSET score; cap 600',
  ADD COLUMN crm_lookup_enabled TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN recording_disclosure_audio VARCHAR(255) DEFAULT NULL
    COMMENT 'WAV path played before queue entry; overrides ingroup fallback',
  ADD COLUMN business_hours_id BIGINT DEFAULT NULL
    COMMENT 'FK to call_times; NULL = always open';

-- =============================================================================
-- 3.6  Additive ALTER on ingroups (+17 columns) (I01 PLAN §3.6)
-- =============================================================================

ALTER TABLE ingroups
  ADD COLUMN routing_strategy ENUM('skill_priority','longest_idle','round_robin','top_down','fewest_calls')
    NOT NULL DEFAULT 'skill_priority',
  ADD COLUMN sticky_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN sticky_window_hours SMALLINT NOT NULL DEFAULT 24,
  ADD COLUMN sticky_first_try_seconds SMALLINT NOT NULL DEFAULT 15,
  ADD COLUMN sticky_wait_during_wrapup TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN wrapup_seconds SMALLINT DEFAULT NULL
    COMMENT 'NULL = inherit from campaign or system default 60s',
  ADD COLUMN recording_mode ENUM('NEVER','ONDEMAND','ALL','ALLFORCE') NOT NULL DEFAULT 'ALL',
  ADD COLUMN recording_disclosure_audio VARCHAR(255) DEFAULT NULL
    COMMENT 'Fallback if did_numbers.recording_disclosure_audio is NULL',
  ADD COLUMN moh_stream VARCHAR(255) NOT NULL DEFAULT 'local_stream://moh',
  ADD COLUMN welcome_audio VARCHAR(255) DEFAULT NULL,
  ADD COLUMN position_announce_template VARCHAR(255) DEFAULT NULL,
  ADD COLUMN announce_interval_sec INT NOT NULL DEFAULT 30,
  ADD COLUMN announce_min_wait_sec INT NOT NULL DEFAULT 60,
  ADD COLUMN entry_full_action ENUM('hangup','overflow_ingroup','voicemail','callback_offer','external_transfer')
    NOT NULL DEFAULT 'hangup',
  ADD COLUMN entry_full_target VARCHAR(64) DEFAULT NULL,
  ADD COLUMN callback_offer_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN callback_offer_after_seconds INT NOT NULL DEFAULT 90,
  ADD COLUMN closed_action ENUM('voicemail','hangup','overflow_ingroup','callback_offer')
    NOT NULL DEFAULT 'voicemail',
  ADD COLUMN closed_target VARCHAR(64) DEFAULT NULL,
  ADD COLUMN business_hours_id BIGINT DEFAULT NULL;
