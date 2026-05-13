-- N05: Branded Calling (First Orion / Hiya / TNS)
-- Migration: 20260513320000_n05_branded_calling

-- 1. branded_calling_providers ---------------------------------------------------

CREATE TABLE branded_calling_providers (
  id               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  tenant_id        BIGINT UNSIGNED   NOT NULL DEFAULT 1,

  provider         ENUM(
    'first_orion',
    'hiya',
    'tns'
  ) NOT NULL,

  -- Encrypted API credentials (F02 envelope-encryption pattern)
  credentials_enc  VARBINARY(512)    NOT NULL,
  kek_version      SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- Brand profile (plain JSON — no PII)
  brand_name       VARCHAR(30)       NOT NULL,
  logo_url         VARCHAR(512)      NULL,
  vertical         ENUM(
    'FINANCIAL_SERVICES', 'HEALTHCARE', 'INSURANCE', 'RETAIL',
    'UTILITIES', 'TELEMARKETING', 'NON_PROFIT', 'GOVERNMENT',
    'TECHNOLOGY', 'REAL_ESTATE', 'COLLECTIONS', 'OTHER'
  ) NOT NULL DEFAULT 'OTHER',
  call_reasons     JSON              NOT NULL DEFAULT (JSON_ARRAY()),

  -- Provider-assigned brand ID (null until registered with provider)
  provider_brand_id VARCHAR(128)     NULL,

  brand_status     ENUM(
    'pending',
    'active',
    'rejected',
    'suspended',
    'inactive'
  ) NOT NULL DEFAULT 'pending',

  brand_synced_at  DATETIME(6)       NULL,

  active           BOOLEAN           NOT NULL DEFAULT TRUE,

  created_at       DATETIME(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_bcp_tenant_provider (tenant_id, provider),
  KEY idx_bcp_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. branded_did_registrations ---------------------------------------------------

CREATE TABLE branded_did_registrations (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED  NOT NULL DEFAULT 1,

  did_id              BIGINT UNSIGNED  NOT NULL,
  provider_id         BIGINT UNSIGNED  NOT NULL,

  provider            ENUM(
    'first_orion', 'hiya', 'tns'
  ) NOT NULL,

  provider_number_id  VARCHAR(128)     NULL,
  call_reason         VARCHAR(64)      NOT NULL DEFAULT 'GENERAL_NOTIFICATION',

  status              ENUM(
    'pending',
    'submitted',
    'active',
    'rejected',
    'deregistering',
    'deregistered',
    'error'
  ) NOT NULL DEFAULT 'pending',

  attestation_level   ENUM('A', 'B', 'C') NULL,

  reputation_score    TINYINT UNSIGNED NULL,
  reputation_last_polled_at DATETIME(6) NULL,

  raw_score           DECIMAL(6,2)     NULL,
  raw_score_at        DATETIME(6)      NULL,

  dispute_open        BOOLEAN          NOT NULL DEFAULT FALSE,
  dispute_submitted_at DATETIME(6)     NULL,
  dispute_notes       TEXT             NULL,

  registered_at       DATETIME(6)      NULL,
  deregistered_at     DATETIME(6)      NULL,

  retry_count         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error          TEXT             NULL,

  created_at          DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at          DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                       ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_bdr_did_provider (did_id, provider),
  KEY idx_bdr_tenant_provider_status (tenant_id, provider, status),
  KEY idx_bdr_tenant_score (tenant_id, reputation_score),
  KEY idx_bdr_poll_due (tenant_id, status, reputation_last_polled_at),
  CONSTRAINT fk_bdr_provider FOREIGN KEY (provider_id)
    REFERENCES branded_calling_providers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Add brand_reputation_score to did_numbers -----------------------------------

ALTER TABLE did_numbers
  ADD COLUMN brand_reputation_score TINYINT UNSIGNED NULL
    COMMENT '0-100 normalized score; NULL=unregistered or unpolled',
  ADD KEY idx_dn_brand_score (tenant_id, brand_reputation_score);

-- 4. Extend QuarantineReason enum to include BRAND_REPUTATION --------------------
--    (MySQL requires ALTER TABLE to extend ENUM; the existing values are preserved)

ALTER TABLE number_pool_dids
  MODIFY COLUMN quarantine_reason ENUM(
    'low_answer_rate',
    'high_complaint_rate',
    'manual',
    'label_detected',
    'brand_reputation'
  ) NULL;
