-- X04: Number Pool + Rotation
-- Migration: 20260513300000_x04_number_pools

-- 1. number_pools ----------------------------------------------------------------

CREATE TABLE number_pools (
  id              BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED    NOT NULL DEFAULT 1,
  name            VARCHAR(128)       NOT NULL,
  description     TEXT               NULL,
  strategy        ENUM(
    'health_weighted_lru',
    'round_robin',
    'random',
    'least_recently_used'
  ) NOT NULL DEFAULT 'health_weighted_lru',
  ar_floor        DECIMAL(5,4)       NOT NULL DEFAULT 0.0800,
  ar_min_sample   INT UNSIGNED       NOT NULL DEFAULT 200,
  cr_ceil         DECIMAL(5,4)       NOT NULL DEFAULT 0.0500,
  cr_min_sample   INT UNSIGNED       NOT NULL DEFAULT 100,
  daily_cap       SMALLINT UNSIGNED  NOT NULL DEFAULT 200,
  min_active_size TINYINT UNSIGNED   NOT NULL DEFAULT 3,
  max_concurrent  TINYINT UNSIGNED   NOT NULL DEFAULT 5,
  active          BOOLEAN            NOT NULL DEFAULT TRUE,
  created_at      DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_pools_tenant_name (tenant_id, name),
  KEY idx_pools_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. number_pool_dids -----------------------------------------------------------

CREATE TABLE number_pool_dids (
  id              BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
  pool_id         BIGINT UNSIGNED    NOT NULL,
  did_id          BIGINT UNSIGNED    NOT NULL,
  tenant_id       BIGINT UNSIGNED    NOT NULL DEFAULT 1,
  area_code       CHAR(3)            NOT NULL DEFAULT '',
  quarantined     BOOLEAN            NOT NULL DEFAULT FALSE,
  quarantined_at  DATETIME(6)        NULL,
  quarantine_reason ENUM(
    'low_answer_rate',
    'high_complaint_rate',
    'manual',
    'label_detected'
  ) NULL,
  quarantine_meta JSON               NULL,
  first_used_at   DATETIME(6)        NULL,
  last_used_at    DATETIME(6)        NULL,
  call_count_7d   INT UNSIGNED       NOT NULL DEFAULT 0,
  answer_count_7d INT UNSIGNED       NOT NULL DEFAULT 0,
  call_count_30d  INT UNSIGNED       NOT NULL DEFAULT 0,
  short_call_count_30d INT UNSIGNED  NOT NULL DEFAULT 0,
  complaint_count_30d  INT UNSIGNED  NOT NULL DEFAULT 0,
  health_score    TINYINT UNSIGNED   NOT NULL DEFAULT 100,
  attest_level    ENUM('A','B','C','unknown') NOT NULL DEFAULT 'unknown',
  created_at      DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_pool_did (pool_id, did_id),
  KEY idx_npd_tenant_pool (tenant_id, pool_id, quarantined, health_score),
  KEY idx_npd_did (did_id),
  KEY idx_npd_area_code (pool_id, area_code, quarantined),

  CONSTRAINT fk_npd_pool FOREIGN KEY (pool_id)
    REFERENCES number_pools (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_npd_did  FOREIGN KEY (did_id)
    REFERENCES did_numbers (id) ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. campaigns.number_pool_id amendment ----------------------------------------

ALTER TABLE campaigns
  ADD COLUMN number_pool_id BIGINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'X04: FK to number_pools.id; overrides campaign CID waterfall tier 3',
  ADD CONSTRAINT fk_campaigns_number_pool
    FOREIGN KEY (number_pool_id) REFERENCES number_pools (id)
    ON DELETE SET NULL ON UPDATE NO ACTION;
