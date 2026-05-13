-- S03: Script management — add versioning, active flag, and variables to scripts table;
--      create script_versions table to keep last 10 versions per script.

-- ----------------------------------------------------------------------------
-- 1. Add new columns to scripts
-- ----------------------------------------------------------------------------

ALTER TABLE `scripts`
  ADD COLUMN `active`    TINYINT(1) NOT NULL DEFAULT 1         AFTER `campaign_id`,
  ADD COLUMN `version`   SMALLINT   NOT NULL DEFAULT 1         AFTER `active`,
  ADD COLUMN `variables` JSON       NOT NULL DEFAULT (JSON_ARRAY()) AFTER `version`;

-- Index for filtering by active status per tenant
CREATE INDEX `idx_scripts_t_active` ON `scripts` (`tenant_id`, `active`);

-- ----------------------------------------------------------------------------
-- 2. Create script_versions table
-- ----------------------------------------------------------------------------

CREATE TABLE `script_versions` (
  `id`        BIGINT        NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT        NOT NULL,
  `script_id` BIGINT        NOT NULL,
  `version`   SMALLINT      NOT NULL,
  `name`      VARCHAR(64)   NOT NULL,
  `body`      MEDIUMTEXT    NOT NULL,
  `variables` JSON          NOT NULL DEFAULT (JSON_ARRAY()),
  `saved_at`  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_script_versions_id_v` (`script_id`, `version`),
  KEY `idx_script_versions_t_s` (`tenant_id`, `script_id`),

  CONSTRAINT `fk_script_versions_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE RESTRICT ON UPDATE NO ACTION,

  CONSTRAINT `fk_script_versions_script`
    FOREIGN KEY (`script_id`) REFERENCES `scripts` (`id`)
    ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='S03: version history for scripts, max 10 per script';
