-- =============================================================================
-- C03 — audit_attestation_table
-- Creates the audit_attestation table (one row per signed Merkle attestation).
-- The table is itself chained (per-tenant per-table_name) so forged attestation
-- history is also detected.
--
-- Partitioned by computed_at (RANGE COLUMNS monthly). C04 owns rotation.
-- INSERT-only: triggers from migration 300 + hash_chain trigger below.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `audit_attestation` (
    `id`                    BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id`             BIGINT NOT NULL DEFAULT 1,
    `table_name`            ENUM('audit_log','call_window_audit','originate_audit',
                                 'consent_log','dnc_sync_log') NOT NULL,
    `window_date`           DATE NOT NULL,
    `row_count`             BIGINT NOT NULL DEFAULT 0,
    `first_id`              BIGINT NULL,
    `last_id`               BIGINT NULL,
    `first_row_prev_hash`   CHAR(64) NOT NULL,
    `last_row_row_hash`     CHAR(64) NOT NULL,
    `merkle_root`           CHAR(64) NOT NULL,
    `key_id`                VARCHAR(64) NOT NULL,
    `signature_b64`         VARCHAR(96) NOT NULL,
    `s3_key`                VARCHAR(255) NOT NULL,
    `s3_etag`               VARCHAR(64) NULL,
    `s3_uploaded_at`        DATETIME(6) NULL,
    -- chain columns (chained per tenant_id + table_name)
    `prev_attestation_hash` CHAR(64) NOT NULL DEFAULT '',
    `attestation_hash`      CHAR(64) NOT NULL DEFAULT '',
    `hash_at`               DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `computed_at`           DATETIME(6) NOT NULL,
    `created_at`            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`, `computed_at`),
    UNIQUE KEY `uk_t_table_date` (`tenant_id`, `table_name`, `window_date`),
    INDEX `idx_t_table_computed` (`tenant_id`, `table_name`, `computed_at`),
    INDEX `idx_t_hash_at` (`tenant_id`, `hash_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`computed_at`) (
    PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
    PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
    PARTITION p2026_07 VALUES LESS THAN ('2026-08-01'),
    PARTITION p2026_08 VALUES LESS THAN ('2026-09-01'),
    PARTITION p2026_09 VALUES LESS THAN ('2026-10-01'),
    PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
    PARTITION p2026_11 VALUES LESS THAN ('2026-12-01'),
    PARTITION p2026_12 VALUES LESS THAN ('2027-01-01'),
    PARTITION pmax     VALUES LESS THAN (MAXVALUE)
);

-- hash_chain trigger for audit_attestation
DROP TRIGGER IF EXISTS `audit_attestation_hash_chain`;
DELIMITER //
CREATE TRIGGER `audit_attestation_hash_chain`
BEFORE INSERT ON `audit_attestation`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT attestation_hash
      INTO prior_hash
      FROM `audit_attestation`
     WHERE tenant_id = NEW.tenant_id
       AND table_name = NEW.table_name
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_attestation_hash = prior_hash;
    SET NEW.hash_at = NOW(6);
    SET NEW.attestation_hash = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_attestation_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'audit_attestation',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        NEW.table_name,
        CAST(NEW.window_date AS CHAR),
        CAST(NEW.row_count AS CHAR),
        COALESCE(CAST(NEW.first_id AS CHAR), '\\N'),
        COALESCE(CAST(NEW.last_id AS CHAR), '\\N'),
        NEW.first_row_prev_hash,
        NEW.last_row_row_hash,
        NEW.merkle_root,
        NEW.key_id,
        NEW.signature_b64
    ), 256);
END //
DELIMITER ;
