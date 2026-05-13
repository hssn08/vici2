-- N03 — Salesforce Open CTI Adapter schema migration
-- Timestamp: 20260513340000

-- ---------------------------------------------------------------------------
-- sf_integrations table (one row per tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE sf_integrations (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT       NOT NULL,
  enabled           TINYINT(1)   NOT NULL DEFAULT 0,
  instance_url      VARCHAR(255) NULL,
  client_id         VARCHAR(512) NULL,
  client_secret     BLOB         NULL     COMMENT 'AES-256-GCM encrypted Consumer Secret',
  access_token      BLOB         NULL     COMMENT 'AES-256-GCM encrypted access token',
  refresh_token     BLOB         NULL     COMMENT 'AES-256-GCM encrypted refresh token',
  token_expiry      DATETIME(6)  NULL,
  field_mappings    JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  last_writeback_at DATETIME(6)  NULL,
  last_error        TEXT         NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sf_tenant (tenant_id),
  CONSTRAINT fk_sf_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Lead model additions: sf_record_id + sf_object_type columns
-- ---------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN sf_record_id   VARCHAR(32) NULL AFTER is_business,
  ADD COLUMN sf_object_type VARCHAR(32) NULL AFTER sf_record_id,
  ADD INDEX  idx_leads_sf_record (sf_record_id);
