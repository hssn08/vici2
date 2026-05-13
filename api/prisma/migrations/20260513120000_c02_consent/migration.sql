-- =============================================================================
-- C02 amendment — Recording Consent State Matrix schema additions.
--
-- All ADDITIVE: no DROP COLUMN, no breaking changes, no data loss.
-- MySQL 8 ALTER ADD COLUMN with DEFAULT is INSTANT for InnoDB.
--
-- Per C02 PLAN §9 (spec/modules/C02/PLAN.md):
--   §9.1  consent_log table (INSERT-only, monthly partitioned, 7-year retention)
--   §9.2  tenants.consent_minimum_mode + tenants.default_caller_state
--   §9.3  campaigns.consent_policy_override + recording_purpose + opt_out_action
--          + consent_msg_audio
--   §9.4  leads.is_business (coordinate with D01)
--
-- Partitioned table (consent_log) created below inline.
-- Audit grants (INSERT/SELECT-only on consent_log) owned by C03 IMPLEMENT.
-- =============================================================================

-- §9.2 tenants — C02 additions
ALTER TABLE `tenants`
  ADD COLUMN `consent_minimum_mode`
    ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP')
    NOT NULL DEFAULT 'PROMPT_MESSAGE',
  ADD COLUMN `default_caller_state` CHAR(2) NULL;

-- §9.3 campaigns — C02 additions
ALTER TABLE `campaigns`
  ADD COLUMN `consent_policy_override`
    ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP') NULL,
  ADD COLUMN `recording_purpose`
    ENUM('general','training','quality_control','monitoring') NOT NULL DEFAULT 'general',
  ADD COLUMN `opt_out_action`
    ENUM('continue_no_record','hangup') NOT NULL DEFAULT 'continue_no_record',
  ADD COLUMN `consent_msg_audio` VARCHAR(255) NULL;

-- §9.4 leads — C02 addition (coordinate with D01)
-- D01 PLAN may have already added is_business; IF NOT EXISTS guard not
-- available in MySQL ALTER, so this will fail if D01 landed it first.
-- Orchestrator must check and skip if already present.
ALTER TABLE `leads`
  ADD COLUMN `is_business` TINYINT(1) NOT NULL DEFAULT 0;

-- §9.1 consent_log — INSERT-only, monthly partitioned
-- PRIMARY KEY (id, recorded_at) required by MySQL PARTITION BY RANGE COLUMNS.
-- NO FOREIGN KEYS on partitioned tables (MySQL limitation).
-- Tenant-id-first on all composite indexes per F02 PLAN tenant-isolation CI check.
CREATE TABLE `consent_log` (
  `id`             BIGINT NOT NULL AUTO_INCREMENT,
  `tenant_id`      BIGINT NOT NULL DEFAULT 1,
  `call_uuid`      VARCHAR(40) NOT NULL,
  `lead_id`        BIGINT NOT NULL,
  `campaign_id`    VARCHAR(32) NOT NULL,
  `user_id`        BIGINT NULL,
  `lead_state`     CHAR(2) NULL,
  `caller_state`   CHAR(2) NULL,
  `decision`       ENUM('ALLOW','PROMPT_BEEP','PROMPT_MESSAGE','REQUIRE_ACTIVE','SKIP') NOT NULL,
  `mechanism`      VARCHAR(64) NOT NULL,
  `state_applied`  CHAR(2) NULL,
  `consent_status` ENUM('pending','not_required','prompted_accepted','prompted_declined',
                        'prompted_assumed','beep_only','skipped')
                   NOT NULL DEFAULT 'pending',
  `reason`         VARCHAR(64) NOT NULL,
  `citation`       VARCHAR(128) NULL,
  `recorded_at`    DATETIME(6) NOT NULL,
  `created_at`     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`, `recorded_at`),
  INDEX `idx_consent_log_t_lead_ts`     (`tenant_id`, `lead_id`, `recorded_at`),
  INDEX `idx_consent_log_t_call`        (`tenant_id`, `call_uuid`),
  INDEX `idx_consent_log_t_state_ts`    (`tenant_id`, `state_applied`, `recorded_at`),
  INDEX `idx_consent_log_t_decision_ts` (`tenant_id`, `decision`, `recorded_at`)
) ENGINE=InnoDB
PARTITION BY RANGE COLUMNS(`recorded_at`) (
  PARTITION `p2026_05` VALUES LESS THAN ('2026-06-01'),
  PARTITION `p2026_06` VALUES LESS THAN ('2026-07-01'),
  PARTITION `p2026_07` VALUES LESS THAN ('2026-08-01'),
  PARTITION `p2026_08` VALUES LESS THAN ('2026-09-01'),
  PARTITION `p2026_09` VALUES LESS THAN ('2026-10-01'),
  PARTITION `p2026_10` VALUES LESS THAN ('2026-11-01'),
  PARTITION `p2026_11` VALUES LESS THAN ('2026-12-01'),
  PARTITION `p2026_12` VALUES LESS THAN ('2027-01-01'),
  PARTITION `p2027_01` VALUES LESS THAN ('2027-02-01'),
  PARTITION `p2027_02` VALUES LESS THAN ('2027-03-01'),
  PARTITION `p2027_03` VALUES LESS THAN ('2027-04-01'),
  -- rolled forward by C03/C04 partition-maintainer cron
  PARTITION `pmax`     VALUES LESS THAN (MAXVALUE)
);
