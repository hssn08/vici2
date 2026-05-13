-- N06 — FCC Reassigned Numbers Database Scrub
-- Migration: 20260513290000_n06_rnd_scrub
-- Additive only — no DROP or ALTER of existing columns.

-- ---------------------------------------------------------------------------
-- 1. tenant_rnd_config — per-tenant RND credentials + settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `tenant_rnd_config` (
  `tenant_id`             BIGINT         NOT NULL,
  `client_id`             VARCHAR(255)   NOT NULL,
  `client_secret_enc`     VARBINARY(512) NOT NULL,
  `client_secret_iv`      VARBINARY(16)  NOT NULL,
  `tier`                  ENUM('xs','small','medium','large','xl','jumbo') NOT NULL DEFAULT 'xs',
  `monthly_budget_cents`  INT            NULL,
  `auto_scrub_on_launch`  TINYINT(1)     NOT NULL DEFAULT 1,
  `rescrub_interval_days` TINYINT        NOT NULL DEFAULT 55,
  `no_data_policy`        ENUM('safe','block') NOT NULL DEFAULT 'safe',
  `use_reassigned_dnc`    TINYINT(1)     NOT NULL DEFAULT 1,
  `is_active`             TINYINT(1)     NOT NULL DEFAULT 0,
  `created_at`            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`tenant_id`),
  CONSTRAINT `fk_tenant_rnd_config_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. rnd_scrub_job — one row per scrub invocation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `rnd_scrub_job` (
  `id`                   CHAR(26)       NOT NULL,
  `tenant_id`            BIGINT         NOT NULL,
  `campaign_id`          VARCHAR(32)    NOT NULL,
  `triggered_by`         BIGINT         NULL,
  `trigger_reason`       ENUM('manual','auto_launch','scheduled_rescrub') NOT NULL,
  `status`               ENUM('queued','running','completed','failed','paused_budget') NOT NULL DEFAULT 'queued',
  `total_phones`         INT            NOT NULL DEFAULT 0,
  `phones_queried`       INT            NOT NULL DEFAULT 0,
  `phones_yes`           INT            NOT NULL DEFAULT 0,
  `phones_no`            INT            NOT NULL DEFAULT 0,
  `phones_no_data`       INT            NOT NULL DEFAULT 0,
  `phones_error`         INT            NOT NULL DEFAULT 0,
  `estimated_cost_cents` INT            NOT NULL DEFAULT 0,
  `actual_cost_cents`    INT            NOT NULL DEFAULT 0,
  `upload_id`            VARCHAR(255)   NULL,
  `query_mode`           ENUM('api','sftp') NOT NULL DEFAULT 'api',
  `started_at`           DATETIME(6)    NULL,
  `completed_at`         DATETIME(6)    NULL,
  `error_message`        TEXT           NULL,
  `created_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  INDEX `idx_rnd_scrub_job_tenant_campaign` (`tenant_id`, `campaign_id`),
  INDEX `idx_rnd_scrub_job_status` (`status`, `created_at`),
  CONSTRAINT `fk_rnd_scrub_job_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. rnd_lookup_log — per-number query results (partitioned by month)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `rnd_lookup_log` (
  `id`               BIGINT       NOT NULL AUTO_INCREMENT,
  `tenant_id`        BIGINT       NOT NULL,
  `scrub_job_id`     CHAR(26)     NOT NULL,
  `phone_e164`       VARCHAR(16)  NOT NULL,
  `consent_date`     DATE         NOT NULL,
  `consent_date_src` ENUM('pewc','ebr','inferred','fallback') NOT NULL DEFAULT 'inferred',
  `result`           ENUM('yes','no','no_data','error') NOT NULL,
  `disconnect_date`  DATE         NULL,
  `queried_at`       DATETIME(6)  NOT NULL,
  `lookup_date`      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `dnc_inserted`     TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`, `lookup_date`),
  INDEX `idx_rnd_log_tenant_phone` (`tenant_id`, `phone_e164`, `lookup_date`),
  INDEX `idx_rnd_log_job` (`scrub_job_id`),
  INDEX `idx_rnd_log_result` (`result`, `lookup_date`),
  CONSTRAINT `fk_rnd_log_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
PARTITION BY RANGE (UNIX_TIMESTAMP(`lookup_date`)) (
  PARTITION `p2026_05` VALUES LESS THAN (UNIX_TIMESTAMP('2026-06-01')),
  PARTITION `p2026_06` VALUES LESS THAN (UNIX_TIMESTAMP('2026-07-01')),
  PARTITION `p2026_07` VALUES LESS THAN (UNIX_TIMESTAMP('2026-08-01')),
  PARTITION `p_future`  VALUES LESS THAN MAXVALUE
);

-- ---------------------------------------------------------------------------
-- 4. rnd_usage_log — monthly cost tracking
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `rnd_usage_log` (
  `id`                   INT          NOT NULL AUTO_INCREMENT,
  `tenant_id`            BIGINT       NOT NULL,
  `period_year`          SMALLINT     NOT NULL,
  `period_month`         TINYINT      NOT NULL,
  `queries_count`        INT          NOT NULL DEFAULT 0,
  `estimated_cost_cents` INT          NOT NULL DEFAULT 0,
  `scrub_job_count`      INT          NOT NULL DEFAULT 0,
  `last_updated_at`      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_rnd_usage_tenant_period` (`tenant_id`, `period_year`, `period_month`),
  CONSTRAINT `fk_rnd_usage_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. campaigns — add RND columns (idempotent via information_schema checks)
-- ---------------------------------------------------------------------------

SET @dbname = DATABASE();

-- rnd_auto_scrub
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME   = 'campaigns'
    AND COLUMN_NAME  = 'rnd_auto_scrub'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `campaigns` ADD COLUMN `rnd_auto_scrub` TINYINT(1) NOT NULL DEFAULT 1 AFTER `hot_keys_active`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rnd_last_scrub_at
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME   = 'campaigns'
    AND COLUMN_NAME  = 'rnd_last_scrub_at'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `campaigns` ADD COLUMN `rnd_last_scrub_at` DATETIME(6) NULL AFTER `rnd_auto_scrub`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rnd_last_scrub_id
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME   = 'campaigns'
    AND COLUMN_NAME  = 'rnd_last_scrub_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `campaigns` ADD COLUMN `rnd_last_scrub_id` CHAR(26) NULL AFTER `rnd_last_scrub_at`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rnd_scrub_status
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME   = 'campaigns'
    AND COLUMN_NAME  = 'rnd_scrub_status'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE `campaigns` ADD COLUMN `rnd_scrub_status` ENUM('never','pending','running','completed','failed','paused_budget') NOT NULL DEFAULT 'never' AFTER `rnd_last_scrub_id`",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- use_reassigned_dnc
SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME   = 'campaigns'
    AND COLUMN_NAME  = 'use_reassigned_dnc'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `campaigns` ADD COLUMN `use_reassigned_dnc` TINYINT(1) NOT NULL DEFAULT 1 AFTER `rnd_scrub_status`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
