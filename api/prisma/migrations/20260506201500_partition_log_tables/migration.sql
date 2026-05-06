-- =============================================================================
-- F02 — Partition the five log tables.
--
-- Per F02 PLAN §3.2, §6:
--   - Prisma cannot emit PARTITION BY syntax. The init migration created
--     these tables un-partitioned. This follow-on migration drops and
--     re-creates them with RANGE COLUMNS partitioning.
--   - +3 months pre-created (current month is 2026-05; pre-create through
--     2026-08 plus a p_max sentinel).
--   - Schema (columns, types, indexes, PK) MUST mirror the init migration.
--   - Partition column must be in the PRIMARY KEY (MySQL hard rule).
--   - C04 owns subsequent month rotation.
--   - These tables have NO foreign keys (MySQL hard rule for partitioned
--     tables); referential integrity is enforced at the app layer.
--
-- Retention windows (informational; rotation is C04's job):
--   call_log       24 months hot
--   agent_log      13 months
--   recording_log  7 years
--   drop_log       7 years
--   audit_log      7 years
--
-- Down migration: see migration.down.sql (dev/test only; production
-- forward-fix only — partitioned tables cannot be rolled back without
-- ARCHIVE first).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. call_log  (partition by call_started, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `call_log`;

CREATE TABLE `call_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `uuid` VARCHAR(40) NOT NULL,
    `parent_uuid` VARCHAR(40) NULL,
    `lead_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `list_id` BIGINT NULL,
    `user_id` BIGINT NULL,
    `direction` ENUM('out', 'in') NOT NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `caller_id` VARCHAR(16) NULL,
    `carrier_id` BIGINT NULL,
    `gateway_id` BIGINT NULL,
    `call_started` DATETIME(6) NOT NULL,
    `call_answered` DATETIME(6) NULL,
    `call_ended` DATETIME(6) NULL,
    `ring_seconds` INTEGER NULL,
    `talk_seconds` INTEGER NULL,
    `hold_seconds` INTEGER NULL,
    `wrap_seconds` INTEGER NULL,
    `status` VARCHAR(8) NULL,
    `hangup_cause` VARCHAR(32) NULL,
    `amd_result` ENUM('none', 'machine', 'human', 'unknown') NOT NULL DEFAULT 'none',
    `is_drop` BOOLEAN NOT NULL DEFAULT false,
    `recording_id` BIGINT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `call_started`),
    UNIQUE KEY `uk_call_log_uuid` (`uuid`, `call_started`),
    KEY `idx_call_log_t_camp_started` (`tenant_id`, `campaign_id`, `call_started`),
    KEY `idx_call_log_t_lead_started` (`tenant_id`, `lead_id`, `call_started`),
    KEY `idx_call_log_t_user_started` (`tenant_id`, `user_id`, `call_started`),
    KEY `idx_call_log_t_phone_started` (`tenant_id`, `phone_e164`, `call_started`),
    KEY `idx_call_log_t_status_started` (`tenant_id`, `status`, `call_started`),
    KEY `idx_call_log_t_carrier_started` (`tenant_id`, `carrier_id`, `call_started`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`call_started`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 2. agent_log  (partition by event_at, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `agent_log`;

CREATE TABLE `agent_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `user_id` BIGINT NOT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `call_log_id` BIGINT NULL,
    `event_at` DATETIME(6) NOT NULL,
    `event` ENUM('login', 'logout', 'pause', 'unpause', 'ready', 'call_start', 'call_end', 'dispo', 'transfer', 'hold', 'retrieve') NOT NULL,
    `pause_code` VARCHAR(16) NULL,
    `duration_sec` INTEGER NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `event_at`),
    KEY `idx_agent_log_t_user_event` (`tenant_id`, `user_id`, `event_at`),
    KEY `idx_agent_log_t_camp_event` (`tenant_id`, `campaign_id`, `event_at`),
    KEY `idx_agent_log_t_call` (`tenant_id`, `call_log_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`event_at`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 3. recording_log  (partition by start_time, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `recording_log`;

CREATE TABLE `recording_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `uuid` VARCHAR(40) NOT NULL,
    `call_log_id` BIGINT NULL,
    `lead_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `user_id` BIGINT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `storage_url` VARCHAR(512) NULL,
    `start_time` DATETIME(6) NOT NULL,
    `duration_sec` INTEGER NULL,
    `size_bytes` BIGINT NULL,
    `encoded_at` DATETIME(6) NULL,
    `consent_status` ENUM('not_required', 'prompted_accepted', 'prompted_declined', 'assumed') NOT NULL DEFAULT 'not_required',
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `start_time`),
    UNIQUE KEY `uk_recording_log_uuid` (`uuid`, `start_time`),
    KEY `idx_recording_log_t_lead_started` (`tenant_id`, `lead_id`, `start_time`),
    KEY `idx_recording_log_t_camp_started` (`tenant_id`, `campaign_id`, `start_time`),
    KEY `idx_recording_log_t_call` (`tenant_id`, `call_log_id`),
    KEY `idx_recording_log_t_user_started` (`tenant_id`, `user_id`, `start_time`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`start_time`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 4. drop_log  (partition by dropped_at, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `drop_log`;

CREATE TABLE `drop_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `call_log_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NOT NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `dropped_at` DATETIME(6) NOT NULL,
    `drop_reason` ENUM('no_agent', 'timeout', 'queue_full') NOT NULL,
    `safe_harbor_played` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `dropped_at`),
    KEY `idx_drop_log_t_camp_dropped` (`tenant_id`, `campaign_id`, `dropped_at`),
    KEY `idx_drop_log_t_call` (`tenant_id`, `call_log_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`dropped_at`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);

-- -----------------------------------------------------------------------------
-- 5. audit_log  (partition by ts, monthly)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `audit_log`;

CREATE TABLE `audit_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `actor_user_id` BIGINT NULL,
    `actor_kind` ENUM('user', 'system', 'worker', 'external_api') NOT NULL DEFAULT 'user',
    `action` VARCHAR(64) NOT NULL,
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id` VARCHAR(64) NULL,
    `before_json` JSON NULL,
    `after_json` JSON NULL,
    `request_id` VARCHAR(64) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `ts` DATETIME(6) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `ts`),
    KEY `idx_audit_t_actor_ts` (`tenant_id`, `actor_user_id`, `ts`),
    KEY `idx_audit_t_entity_ts` (`tenant_id`, `entity_type`, `entity_id`, `ts`),
    KEY `idx_audit_t_action_ts` (`tenant_id`, `action`, `ts`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`ts`) (
    PARTITION p_pre      VALUES LESS THAN ('2026-05-01'),
    PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
    PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
    PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
    PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),
    PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);
