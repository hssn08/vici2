-- S04 — Supervisor Wallboard: wallboard_layouts table
-- Stores per-tenant wallboard layout configuration (board order, rotation interval).
-- Additive only; no DROP statements.

CREATE TABLE IF NOT EXISTS `wallboard_layouts` (
  `id`             BIGINT         NOT NULL AUTO_INCREMENT,
  `tenant_id`      BIGINT         NOT NULL DEFAULT 1,
  `name`           VARCHAR(128)   NOT NULL,
  `boards`         JSON           NOT NULL COMMENT 'Ordered array of board IDs',
  `rotate_seconds` INT            NOT NULL DEFAULT 30,
  `active`         TINYINT(1)     NOT NULL DEFAULT 1,
  `created_at`     DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`     DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  KEY `idx_wallboard_tenant_active` (`tenant_id`, `active`),
  CONSTRAINT `fk_wallboard_tenant`
    FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
