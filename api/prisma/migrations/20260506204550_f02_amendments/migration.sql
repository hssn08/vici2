-- =============================================================================
-- F02 amendments — additive batch consolidating C01 / T02 / D01 / D05 / E01 / T04.
--
-- All ADDITIVE: no DROP COLUMN, no breaking changes, no data loss. Per
-- orchestrator brief (feat/F02-amendments). MySQL 8 ALTER ADD COLUMN with
-- DEFAULT is INSTANT for InnoDB.
--
-- Layout (kept aligned with original Prisma diff but JSON DEFAULTs added so
-- the existing campaigns/carriers row(s) are accepted):
--
--   1. ALTER tenants               D05.4
--   2. ALTER campaigns             C01.3 + E01.1..15
--   3. ALTER carriers              T02.1..6 (kind enum widening + 5 cols)
--   4. ALTER gateways              T02.7..10
--   5. ALTER leads                 D01.1 + C01.4
--   6. ALTER lists                 T04.3..4
--   7. CREATE campaign_status_overrides       E01.16
--   8. CREATE state_holidays                  C01.2 (NOT partitioned — small)
--   9. CREATE dnc_sync_config                 D05.2
--  10. (partitioned tables created in 20260506204600_partition_amendment_tables/)
--  11. (audit grants for new immutable tables in 20260506204700_audit_grants_amendments/)
--
-- Partitioned tables (call_window_audit, dnc_sync_log, originate_audit) are
-- created with PARTITION BY in the FOLLOWING migration so this file remains
-- pure ALTER + non-partitioned CREATE statements (mirrors the F02 init →
-- partition_log_tables split).
-- =============================================================================

-- 1. tenants — D05.4
ALTER TABLE `tenants`
  ADD COLUMN `internal_dnc_retention_years` SMALLINT NOT NULL DEFAULT 5;

-- 2. campaigns — C01.3 + E01.1..15
ALTER TABLE `campaigns`
  ADD COLUMN `unknown_tz_policy` ENUM('deny', 'warn_pass') NOT NULL DEFAULT 'deny',
  ADD COLUMN `dial_level` DECIMAL(4, 2) NOT NULL DEFAULT 1.50,
  ADD COLUMN `lock_ttl_sec` SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN `min_hopper_level` INT NOT NULL DEFAULT 50,
  ADD COLUMN `max_hopper_level` INT NOT NULL DEFAULT 5000,
  ADD COLUMN `hopper_buffer_multiplier` DECIMAL(3, 1) NOT NULL DEFAULT 1.5,
  ADD COLUMN `recycle_delay_seconds` INT NOT NULL DEFAULT 600,
  ADD COLUMN `max_calls_per_lead` TINYINT NOT NULL DEFAULT 5,
  ADD COLUMN `dial_statuses` JSON NOT NULL DEFAULT (JSON_ARRAY('NEW', 'NA', 'B', 'CALLBK')),
  ADD COLUMN `low_water_pct` TINYINT NOT NULL DEFAULT 25,
  ADD COLUMN `high_water_pct` TINYINT NOT NULL DEFAULT 90,
  ADD COLUMN `over_fetch_ratio` DECIMAL(3, 1) NOT NULL DEFAULT 1.5,
  ADD COLUMN `machine_terminal` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `lead_filter_sql` TEXT NULL,
  ADD COLUMN `multi_list_mix` ENUM('EVEN', 'MULTI', 'NONE') NOT NULL DEFAULT 'EVEN';

-- 3. carriers — T02.1 (enum widen) + T02.2..6
-- The legacy 'telnyx' value is kept; T02 IMPLEMENT will retag rows to
-- telnyx-creds / telnyx-ip based on register flag. No UPDATE in this
-- additive migration.
ALTER TABLE `carriers`
  MODIFY `kind` ENUM('twilio', 'telnyx', 'telnyx-creds', 'telnyx-ip', 'signalwire', 'ringcentral', 'bandwidth', 'flowroute', 'byoc') NOT NULL,
  ADD COLUMN `send_pai` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `is_emergency` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `max_concurrent` INT NULL,
  ADD COLUMN `notes` JSON NOT NULL DEFAULT (JSON_OBJECT()),
  ADD COLUMN `version` INT NOT NULL DEFAULT 1;

-- 4. gateways — T02.7..10
ALTER TABLE `gateways`
  ADD COLUMN `weight` SMALLINT NOT NULL DEFAULT 100,
  ADD COLUMN `max_concurrent` INT NULL,
  ADD COLUMN `version` INT NOT NULL DEFAULT 1,
  ADD COLUMN `cost_per_min_cents` INT NULL;

-- 5. leads — D01.1 + C01.4
ALTER TABLE `leads`
  ADD COLUMN `tz_blocked` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `version` SMALLINT NOT NULL DEFAULT 1;

-- 6. lists — T04.3..4
ALTER TABLE `lists`
  ADD COLUMN `caller_id_override` VARCHAR(16) NULL,
  ADD COLUMN `caller_id_name` VARCHAR(32) NULL;

-- 7. campaign_status_overrides — E01.16
CREATE TABLE `campaign_status_overrides` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `campaign_id` VARCHAR(32) NOT NULL,
    `status_code` VARCHAR(8) NOT NULL,
    `recycle_delay_seconds` INT NULL,
    `max_calls` TINYINT NULL,
    `notes` VARCHAR(255) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`tenant_id`, `campaign_id`, `status_code`),
    KEY `idx_camp_status_ovr_t_status` (`tenant_id`, `status_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `campaign_status_overrides`
  ADD CONSTRAINT `fk_camp_status_ovr_campaign`
  FOREIGN KEY (`tenant_id`, `campaign_id`)
  REFERENCES `campaigns`(`tenant_id`, `id`)
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- 8. state_holidays — C01.2 (NOT partitioned — global lookup)
CREATE TABLE `state_holidays` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `state_code` CHAR(2) NOT NULL,
    `holiday_date` DATE NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `citation` VARCHAR(128) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_state_holidays_state_date` (`state_code`, `holiday_date`),
    KEY `idx_state_holidays_date` (`holiday_date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 9. dnc_sync_config — D05.2 (single-row-per-source; no partitioning)
CREATE TABLE `dnc_sync_config` (
    `source` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `cadence` ENUM('daily', 'weekly', 'monthly', 'quarterly') NOT NULL,
    `last_run_at` DATETIME(6) NULL,
    `next_run_at` DATETIME(6) NULL,
    `config_json` JSON NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`source`),
    KEY `idx_dnc_sync_config_enabled_next` (`enabled`, `next_run_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 10. dnc_sentinel tenant row (id=0) — D05.1
-- Allows global federal/state/litigator DNC rows without breaking the
-- `dnc.fk_dnc_tenant` FK. INSERT IGNORE so re-runs are safe; auto-increment
-- is unaffected.
--
-- MySQL by default treats INSERT INTO ... (id) VALUES (0) as "use the next
-- auto-increment value". NO_AUTO_VALUE_ON_ZERO toggles that behaviour so
-- the literal 0 is stored. Scoped to this session — does not affect the
-- global server config.
SET @old_sql_mode := @@sql_mode;
SET sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO');

INSERT IGNORE INTO `tenants` (`id`, `name`, `slug`, `active`, `settings`, `internal_dnc_retention_years`)
VALUES (0, '__GLOBAL_DNC_SENTINEL__', '__global_dnc_sentinel__', false, JSON_OBJECT(), 5);

SET sql_mode = @old_sql_mode;
