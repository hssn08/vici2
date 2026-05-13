-- O03 — alert_receivers table
-- Per-tenant alert receiver config for Slack, PagerDuty, and generic webhooks.
-- Delivery via BullMQ worker with exponential backoff (O03 PLAN §5).

CREATE TABLE `alert_receivers` (
  `id`              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `tenant_id`       BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  `name`            VARCHAR(128)     NOT NULL,
  `kind`            ENUM('slack','pagerduty','webhook') NOT NULL,
  `config`          JSON             NOT NULL,
  `active`          BOOLEAN          NOT NULL DEFAULT TRUE,
  `severity_filter` VARCHAR(32)      NOT NULL DEFAULT 'page,warn,info',
  `created_at`      DATETIME(6)      NOT NULL DEFAULT NOW(6),
  `updated_at`      DATETIME(6)      NOT NULL DEFAULT NOW(6) ON UPDATE NOW(6),
  PRIMARY KEY (`id`),
  INDEX `idx_ar_tenant_kind`   (`tenant_id`, `kind`),
  INDEX `idx_ar_tenant_active` (`tenant_id`, `active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
