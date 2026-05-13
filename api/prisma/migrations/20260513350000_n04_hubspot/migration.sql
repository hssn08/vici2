-- N04: HubSpot Integration
-- Migration: 20260513350000_n04_hubspot

-- 1. hubspot_integrations -------------------------------------------------------

CREATE TABLE hubspot_integrations (
  id                       BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
  tenant_id                BIGINT UNSIGNED    NOT NULL,
  portal_id                BIGINT UNSIGNED    NOT NULL,
  hub_domain               VARCHAR(128)       NULL,

  -- Envelope-encrypted OAuth tokens (F05 AES-GCM-256 envelope pattern)
  access_token_enc         VARBINARY(512)     NOT NULL,
  refresh_token_enc        VARBINARY(512)     NOT NULL,
  kek_version              SMALLINT UNSIGNED  NOT NULL DEFAULT 1,
  token_expires_at         DATETIME(6)        NOT NULL,

  -- Sync configuration
  status                   ENUM('connected','error','disconnected') NOT NULL DEFAULT 'connected',
  sync_mode                ENUM('ALL_CONTACTS','LIST_ONLY') NOT NULL DEFAULT 'ALL_CONTACTS',
  sync_interval_minutes    SMALLINT UNSIGNED  NOT NULL DEFAULT 15,
  last_sync_cursor         DATETIME(6)        NULL,
  last_sync_at             DATETIME(6)        NULL,
  rate_limit_backoff_until DATETIME(6)        NULL,

  -- Configurable JSON mappings
  status_map               JSON               NOT NULL DEFAULT (JSON_OBJECT()),
  disposition_map          JSON               NOT NULL DEFAULT (JSON_OBJECT()),

  -- Feature toggles
  include_recording_url    BOOLEAN            NOT NULL DEFAULT TRUE,
  sync_overwrites_manual_edits BOOLEAN        NOT NULL DEFAULT FALSE,

  -- Soft delete
  deleted_at               DATETIME(6)        NULL,
  created_at               DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at               DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                              ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_hs_integration_tenant (tenant_id),
  KEY idx_hs_integration_portal_id (portal_id),
  CONSTRAINT fk_hs_integration_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. hubspot_sync_jobs ---------------------------------------------------------

CREATE TABLE hubspot_sync_jobs (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id            BIGINT UNSIGNED  NOT NULL,
  integration_id       BIGINT UNSIGNED  NOT NULL,
  bullmq_job_id        VARCHAR(64)      NULL,
  status               ENUM('running','completed','failed','cancelled') NOT NULL DEFAULT 'running',
  sync_mode            ENUM('ALL_CONTACTS','LIST_ONLY') NOT NULL,
  paging_cursor        VARCHAR(256)     NULL,

  -- Progress counters
  contacts_fetched     INT UNSIGNED     NOT NULL DEFAULT 0,
  contacts_upserted    INT UNSIGNED     NOT NULL DEFAULT 0,
  contacts_skipped     INT UNSIGNED     NOT NULL DEFAULT 0,
  contacts_failed      INT UNSIGNED     NOT NULL DEFAULT 0,
  error_summary        JSON             NULL,

  -- Timing
  started_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at         DATETIME(6)      NULL,
  created_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                        ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  KEY idx_hs_sync_job_tenant_started (tenant_id, started_at DESC),
  KEY idx_hs_sync_job_integration_status (integration_id, status),
  CONSTRAINT fk_hs_sync_job_integration
    FOREIGN KEY (integration_id) REFERENCES hubspot_integrations (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. lead_external_refs --------------------------------------------------------

CREATE TABLE lead_external_refs (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED  NOT NULL,
  lead_id        BIGINT UNSIGNED  NOT NULL,
  source         VARCHAR(32)      NOT NULL,
  external_id    VARCHAR(128)     NOT NULL,
  sync_warnings  JSON             NULL,
  last_synced_at DATETIME(6)      NULL,
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_ler_tenant_source_ext (tenant_id, source, external_id),
  KEY idx_ler_tenant_lead (tenant_id, lead_id),
  CONSTRAINT fk_ler_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_ler_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
