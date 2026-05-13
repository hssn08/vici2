-- D02 — imports, import_errors (partitioned), lists.column_mapping
-- ADDITIVE ONLY — no DROP statements.

-- 1. lists.column_mapping  (D02 PLAN §4.3)
ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS column_mapping JSON NULL COMMENT 'D02 column-mapping snapshot (version+rows JSON)';

-- 2. imports table  (D02 PLAN §4.1)
CREATE TABLE IF NOT EXISTS imports (
  id                   CHAR(26)          NOT NULL,
  tenant_id            BIGINT            NOT NULL DEFAULT 1,
  list_id              BIGINT            NOT NULL,
  owner_user_id        BIGINT            NOT NULL,
  status               ENUM('queued','running','done','failed','cancelled') NOT NULL DEFAULT 'queued',
  source_key           VARCHAR(512)      NOT NULL COMMENT 's3://bucket/key or local path',
  errors_key           VARCHAR(512)      NULL,
  file_bytes           BIGINT            NULL,
  row_count_total      INT               NULL,
  row_count_processed  INT               NOT NULL DEFAULT 0 COMMENT 'checkpoint high-water mark',
  row_count_inserted   INT               NOT NULL DEFAULT 0,
  row_count_skipped    INT               NOT NULL DEFAULT 0,
  row_count_errored    INT               NOT NULL DEFAULT 0,
  meta                 JSON              NOT NULL COMMENT 'upload-time options',
  error_summary        JSON              NULL     COMMENT '{byCode:{INVALID_PHONE:n,...}}',
  started_at           DATETIME(6)       NULL,
  completed_at         DATETIME(6)       NULL,
  failed_reason        VARCHAR(255)      NULL,
  error_limit          INT               NOT NULL DEFAULT 10000 COMMENT 'abort above this',
  created_at           DATETIME(6)       NOT NULL DEFAULT NOW(6),
  updated_at           DATETIME(6)       NOT NULL DEFAULT NOW(6) ON UPDATE NOW(6),

  PRIMARY KEY (id),
  INDEX idx_imports_t_status_created (tenant_id, status, created_at),
  INDEX idx_imports_t_list_created   (tenant_id, list_id, created_at),
  CONSTRAINT fk_imports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fk_imports_list
    FOREIGN KEY (list_id) REFERENCES lists (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fk_imports_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='D02 import jobs — 5-year TCPA audit retention';

-- 3. import_errors table — partitioned monthly (D02 PLAN §4.2)
--    Composite PK includes partition column (created_at) per F02 convention.
--    No FK to imports (partitioned tables carry no FK per F02 rule).
CREATE TABLE IF NOT EXISTS import_errors (
  id            BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT        NOT NULL DEFAULT 1,
  import_id     CHAR(26)      NOT NULL,
  source_line   INT           NOT NULL COMMENT 'csv-parse info.lines',
  source_record INT           NOT NULL COMMENT 'csv-parse info.records (0-based)',
  error_code    VARCHAR(48)   NOT NULL,
  error_msg     VARCHAR(512)  NULL,
  raw_row       JSON          NULL     COMMENT 'optional; capped 4 KB; default off',
  created_at    DATETIME(6)   NOT NULL DEFAULT NOW(6),

  PRIMARY KEY (id, created_at),
  INDEX idx_import_errors_t_import_line (tenant_id, import_id, source_line),
  INDEX idx_import_errors_t_import_code (tenant_id, import_id, error_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='D02 per-row import errors — 90-day rolling retention (C04 partition drop)'
  PARTITION BY RANGE COLUMNS(created_at) (
    PARTITION p_2026_05 VALUES LESS THAN ('2026-06-01 00:00:00'),
    PARTITION p_2026_06 VALUES LESS THAN ('2026-07-01 00:00:00'),
    PARTITION p_2026_07 VALUES LESS THAN ('2026-08-01 00:00:00'),
    PARTITION p_future   VALUES LESS THAN (MAXVALUE)
  );

-- 4. Immutability triggers for import_errors (INSERT-only)
DROP TRIGGER IF EXISTS import_errors_no_update;
CREATE TRIGGER import_errors_no_update
  BEFORE UPDATE ON import_errors
  FOR EACH ROW
  SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'import_errors rows are immutable';

DROP TRIGGER IF EXISTS import_errors_no_delete;
CREATE TRIGGER import_errors_no_delete
  BEFORE DELETE ON import_errors
  FOR EACH ROW
  SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'import_errors rows are immutable; use partition rotation';
