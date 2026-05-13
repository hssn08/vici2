-- =============================================================================
-- F02 amendments — create partitioned audit tables.
--
-- Mirrors the F02 init → 20260506201500_partition_log_tables split: Prisma
-- cannot emit PARTITION BY syntax, so the three new partitioned tables
-- (call_window_audit, dnc_sync_log, originate_audit) are created here
-- directly. Schema MUST mirror the Prisma model definitions in
-- api/prisma/schema.prisma.
--
-- Partition pattern matches F02 PLAN §3 / §6:
--   p_pre + p_2026_05..p_2026_08 + p_max  (current month + 3 forward + sentinel)
--
-- C04 owns subsequent monthly rotation. NO foreign keys (MySQL hard rule
-- for partitioned tables); referential integrity is enforced at the app
-- layer.
--
-- Retention windows (informational; rotation is C04's job):
--   call_window_audit  4 years (C01 PLAN §8.1; TCPA evidence)
--   dnc_sync_log       7 years (D05 PLAN §6.5; TCPA evidence)
--   originate_audit    7 years (T04 RESEARCH §7.2; TCPA evidence)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. call_window_audit  (partition by created_at, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `call_window_audit`;

CREATE TABLE `call_window_audit` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `lead_id` BIGINT NOT NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `campaign_id` VARCHAR(32) NOT NULL,
    `decision` ENUM('ALLOW', 'ALLOW_WARN', 'SKIP_UNTIL', 'BLOCK_INVALID') NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `tz_iana` VARCHAR(40) NULL,
    `tz_confidence` ENUM('KNOWN', 'ZIP', 'NXX', 'NPA', 'STATE_DEFAULT', 'CAMPAIGN_DEFAULT', 'NONE') NULL,
    `state_code` CHAR(2) NULL,
    `zip` VARCHAR(16) NULL,
    `party_local` DATETIME(6) NULL,
    `party_dow` TINYINT NULL,
    `effective_open_min` SMALLINT NULL,
    `effective_close_min` SMALLINT NULL,
    `rule_applied` VARCHAR(64) NULL,
    `enforcement_point` ENUM('hopper_filler', 'originate_path', 'pacing', 'manual_dial') NOT NULL,
    `next_open_at` DATETIME(6) NULL,
    `call_uuid` VARCHAR(64) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `created_at`),
    KEY `idx_cwa_t_lead_ts` (`tenant_id`, `lead_id`, `created_at`),
    KEY `idx_cwa_t_decision_ts` (`tenant_id`, `decision`, `created_at`),
    KEY `idx_cwa_t_campaign_ts` (`tenant_id`, `campaign_id`, `created_at`),
    KEY `idx_cwa_t_state_ts` (`tenant_id`, `state_code`, `created_at`),
    KEY `idx_cwa_t_call_uuid` (`tenant_id`, `call_uuid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`created_at`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 2. dnc_sync_log  (partition by started_at, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `dnc_sync_log`;

CREATE TABLE `dnc_sync_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(32) NOT NULL,
    `kind` ENUM('delta', 'full', 'bulk') NOT NULL,
    `outcome` ENUM('success', 'partial', 'failed') NOT NULL DEFAULT 'success',
    `added` INT NOT NULL DEFAULT 0,
    `removed` INT NOT NULL DEFAULT 0,
    `error_count` INT NOT NULL DEFAULT 0,
    `file_hash` VARCHAR(128) NULL,
    `started_at` DATETIME(6) NOT NULL,
    `completed_at` DATETIME(6) NULL,
    `duration_ms` INT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `started_at`),
    KEY `idx_dnc_sync_log_source_started` (`source`, `started_at`),
    KEY `idx_dnc_sync_log_outcome_started` (`outcome`, `started_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`started_at`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 3. originate_audit  (partition by originated_at, monthly)
--
-- Per T04 RESEARCH §7: INSERT-then-one-shot-UPDATE semantics; the DAL guards
-- UPDATE WHERE outcome='OTHER' AND outcome_at IS NULL so a row is never
-- overwritten after finalization. Trigger pair in 20260506204700_*.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `originate_audit`;

CREATE TABLE `originate_audit` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `attempt_uuid` VARCHAR(40) NOT NULL,
    `call_uuid` VARCHAR(40) NULL,
    `lead_id` BIGINT NOT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `list_id` BIGINT NULL,
    `agent_id` BIGINT NULL,
    `mode` ENUM('PROGRESSIVE', 'PREDICTIVE', 'MANUAL', 'PREVIEW') NOT NULL,
    `dial_target` ENUM('CONFERENCE', 'PARK') NOT NULL,
    `carrier_id` BIGINT NULL,
    `gateway_id` BIGINT NULL,
    `gateway_name` VARCHAR(64) NULL,
    `caller_id_number` VARCHAR(16) NULL,
    `caller_id_source` ENUM('per_call', 'per_list', 'local_presence', 'campaign_default') NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `originated_at` DATETIME(6) NOT NULL,
    `tcpa_decision` ENUM('ALLOW', 'BLOCK', 'SKIP') NULL,
    `tcpa_reason` VARCHAR(64) NULL,
    `tcpa_tz_resolved` VARCHAR(64) NULL,
    `dnc_decision` ENUM('ALLOW', 'BLOCK') NULL,
    `dnc_sources` JSON NULL,
    `consent_decision` ENUM('ALLOW', 'PROMPT', 'SKIP_RECORDING', 'BLOCK') NULL,
    `consent_state` CHAR(2) NULL,
    `bypass_token` VARCHAR(64) NULL,
    `outcome` ENUM('SUCCESS', 'TCPA_BLOCKED', 'DNC_BLOCKED', 'CONSENT_BLOCKED', 'GATEWAY_LIMIT', 'RATE_LIMITED', 'GATEWAY_FAIL', 'TIMEOUT', 'JOB_ORPHANED', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `outcome_at` DATETIME(6) NULL,
    `duration_ms` INT NULL,
    `error_message` TEXT NULL,
    `fs_host` VARCHAR(64) NULL,
    `request_id` VARCHAR(64) NULL,
    `ip_address` VARCHAR(45) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `originated_at`),
    UNIQUE KEY `uq_originate_audit_attempt` (`attempt_uuid`, `originated_at`),
    KEY `idx_originate_audit_t_lead_ts` (`tenant_id`, `lead_id`, `originated_at`),
    KEY `idx_originate_audit_t_camp_ts` (`tenant_id`, `campaign_id`, `originated_at`),
    KEY `idx_originate_audit_t_outcome_ts` (`tenant_id`, `outcome`, `originated_at`),
    KEY `idx_originate_audit_call_uuid` (`call_uuid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`originated_at`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);
