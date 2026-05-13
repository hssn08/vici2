-- I02 — IVR Engine migration
-- Adds: ivrs, ivr_nodes, ivr_edges, ivr_prompts, ivr_traversal_log (partitioned)
-- Additive ALTERs on: did_numbers (default_lang, ivr_timeout_sec)
-- Deprecates: ivr_trees.tree_json (NO DROP — backward compat)

-- ─── 1. ivrs ─────────────────────────────────────────────────────────────────

CREATE TABLE `ivrs` (
  `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  `tenant_id`            BIGINT NOT NULL DEFAULT 1,
  `name`                 VARCHAR(128) NOT NULL,
  `description`          TEXT DEFAULT NULL,
  `entry_node_id`        BIGINT DEFAULT NULL
    COMMENT 'FK to ivr_nodes.id; set after first node is created',
  `active`               BOOLEAN NOT NULL DEFAULT TRUE,
  `phase`                ENUM('xml','ivrbridge') NOT NULL DEFAULT 'xml'
    COMMENT 'xml = static dialplan; ivrbridge = Go ESL controller (Phase 2)',
  `max_depth_validated`  TINYINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Cached max depth from last save; renderer rejects if > 3 (Phase 1)',
  `created_at`           DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX `idx_ivrs_t_active` (`tenant_id`, `active`),
  UNIQUE KEY `uk_ivrs_t_name` (`tenant_id`, `name`),
  CONSTRAINT `fk_ivrs_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants`(`id`) ON DELETE RESTRICT
);

-- ─── 2. ivr_nodes ────────────────────────────────────────────────────────────

CREATE TABLE `ivr_nodes` (
  `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
  `tenant_id`        BIGINT NOT NULL DEFAULT 1,
  `ivr_id`           BIGINT NOT NULL,
  `name`             VARCHAR(128) NOT NULL
    COMMENT 'Human-readable label for admin UI',
  `node_type`        ENUM(
                       'collect',
                       'lang_select',
                       'terminal_ingroup',
                       'terminal_hangup',
                       'terminal_voicemail',
                       'terminal_transfer',
                       'terminal_callback'
                     ) NOT NULL,
  `collect_min`      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `collect_max`      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `collect_terminators` VARCHAR(8) NOT NULL DEFAULT 'none'
    COMMENT '"none" for single-digit menus; "#" for multi-digit entry',
  `timeout_ms`       INT UNSIGNED NOT NULL DEFAULT 5000
    COMMENT 'Time to wait for first digit after prompt ends',
  `inter_digit_ms`   INT UNSIGNED NOT NULL DEFAULT 3000
    COMMENT 'Time to wait between digits (multi-digit only)',
  `invalid_max`      TINYINT UNSIGNED NOT NULL DEFAULT 3
    COMMENT 'Hangup/fallback after this many consecutive invalid inputs',
  `action_target`    VARCHAR(128) DEFAULT NULL
    COMMENT 'For terminal nodes: ingroup_id, E.164 number, voicemail_box_id, etc.',
  `position_x`       INT NOT NULL DEFAULT 0,
  `position_y`       INT NOT NULL DEFAULT 0,
  `created_at`       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX `idx_ivr_nodes_t_ivr` (`tenant_id`, `ivr_id`),
  CONSTRAINT `fk_ivr_nodes_ivr` FOREIGN KEY (`ivr_id`)
    REFERENCES `ivrs`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ivr_nodes_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants`(`id`) ON DELETE RESTRICT
);

-- ─── 3. ivr_edges ────────────────────────────────────────────────────────────

CREATE TABLE `ivr_edges` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `tenant_id`     BIGINT NOT NULL DEFAULT 1,
  `ivr_id`        BIGINT NOT NULL,
  `from_node_id`  BIGINT NOT NULL,
  `on_input`      VARCHAR(16) NOT NULL
    COMMENT '"0"-"9","*","#" = digit; "__TIMEOUT__"; "__INVALID_MAX__"',
  `to_node_id`    BIGINT DEFAULT NULL
    COMMENT 'NULL only for terminal edges',
  `label`         VARCHAR(64) DEFAULT NULL
    COMMENT 'Human-readable edge label for admin UI',
  `sort_order`    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX `idx_ivr_edges_t_ivr`  (`tenant_id`, `ivr_id`),
  INDEX `idx_ivr_edges_t_from` (`tenant_id`, `from_node_id`, `on_input`),
  UNIQUE KEY `uk_ivr_edges_from_input` (`from_node_id`, `on_input`),
  CONSTRAINT `fk_ivr_edges_from` FOREIGN KEY (`from_node_id`)
    REFERENCES `ivr_nodes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ivr_edges_to` FOREIGN KEY (`to_node_id`)
    REFERENCES `ivr_nodes`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_ivr_edges_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants`(`id`) ON DELETE RESTRICT
);

-- ─── 4. ivr_prompts ──────────────────────────────────────────────────────────

CREATE TABLE `ivr_prompts` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `tenant_id`       BIGINT NOT NULL DEFAULT 1,
  `node_id`         BIGINT NOT NULL,
  `lang`            VARCHAR(5) NOT NULL DEFAULT 'en'
    COMMENT 'BCP-47 language code: "en", "es", "fr", etc.',
  `file_uri`        VARCHAR(512) NOT NULL
    COMMENT 'S3 URI: s3://vici2-media/ivr/{tenant_id}/{ivr_id}/{node_id}_{lang}.wav',
  `file_size_bytes` INT UNSIGNED DEFAULT NULL,
  `duration_ms`     INT UNSIGNED DEFAULT NULL
    COMMENT 'Populated at upload time after ffprobe',
  `created_at`      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY `uk_ivr_prompts_node_lang` (`node_id`, `lang`),
  INDEX `idx_ivr_prompts_t_node` (`tenant_id`, `node_id`),
  CONSTRAINT `fk_ivr_prompts_node` FOREIGN KEY (`node_id`)
    REFERENCES `ivr_nodes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ivr_prompts_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants`(`id`) ON DELETE RESTRICT
);

-- ─── 5. ivr_traversal_log (partitioned monthly) ──────────────────────────────

CREATE TABLE `ivr_traversal_log` (
  `id`           BIGINT NOT NULL AUTO_INCREMENT,
  `tenant_id`    BIGINT NOT NULL DEFAULT 1,
  `ivr_id`       BIGINT NOT NULL,
  `session_uuid` VARCHAR(40) NOT NULL,
  `node_id`      BIGINT NOT NULL,
  `lang`         VARCHAR(5) NOT NULL DEFAULT 'en',
  `digit`        VARCHAR(8) DEFAULT NULL
    COMMENT 'NULL on timeout; empty string on hangup during prompt',
  `outcome`      ENUM('digit','timeout','hangup','invalid','terminal') NOT NULL,
  `duration_ms`  INT UNSIGNED NOT NULL DEFAULT 0,
  `entered_at`   DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`, `entered_at`),
  INDEX `idx_itl_t_ivr`  (`tenant_id`, `ivr_id`, `entered_at`),
  INDEX `idx_itl_t_sess` (`tenant_id`, `session_uuid`),
  INDEX `idx_itl_t_node` (`tenant_id`, `node_id`, `outcome`, `entered_at`)
) PARTITION BY RANGE (TO_DAYS(`entered_at`)) (
  PARTITION `p_2026_05` VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION `p_2026_06` VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION `p_2026_07` VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION `p_max`     VALUES LESS THAN MAXVALUE
);

-- ─── 6. did_numbers additive ALTERs ──────────────────────────────────────────

ALTER TABLE `did_numbers`
  ADD COLUMN `default_lang`    VARCHAR(5) NOT NULL DEFAULT 'en'
    COMMENT 'Default BCP-47 language for IVR prompt selection',
  ADD COLUMN `ivr_timeout_sec` SMALLINT UNSIGNED NOT NULL DEFAULT 300
    COMMENT 'Hard session timeout in seconds; sched_transfer fires if caller stuck';

-- ─── 7. Deprecate ivr_trees.tree_json (NO DROP) ──────────────────────────────

ALTER TABLE `ivr_trees`
  COMMENT = 'DEPRECATED by I02 IVR engine (ivrs/ivr_nodes/ivr_edges). Retained for backward compat. Do not write new rows.';

-- ─── 8. Seed audit_log entity_types for I02 ──────────────────────────────────

-- audit_log_entity_types table may not exist in all environments; use INSERT IGNORE
INSERT IGNORE INTO `audit_log_entity_types` (`name`) VALUES
  ('ivr'),
  ('ivr_node'),
  ('ivr_edge'),
  ('ivr_prompt');
