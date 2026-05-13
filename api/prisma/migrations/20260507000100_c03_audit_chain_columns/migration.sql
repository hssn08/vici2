-- =============================================================================
-- C03 — audit_chain_columns
-- Adds prev_hash, row_hash, hash_at to all five immutable audit tables plus
-- the index used by the attestation worker scan.
--
-- audit_log already exists (F02 init). The four sister tables were created in
-- 20260506204600_partition_amendment_tables.
--
-- ALGORITHM=INSTANT: MySQL 8 InnoDB allows ADD COLUMN with NOT NULL + no
-- DEFAULT as instant if the column is last; we supply a DEFAULT '' for
-- VARCHAR/CHAR so the ALTER is truly INSTANT (online=no-copy). The trigger
-- (next migration) will populate every new row with the real hash; existing
-- rows (dev/test only) get the sentinel.
--
-- Production note: these tables are empty on first deploy; the INSTANT ADD is
-- a no-op cost-wise. On upgrades with data, the sentinel '' value for existing
-- rows is detectable by the verifier as "pre-chain rows" if needed.
-- =============================================================================

-- 1. audit_log (F02 table; partitioned by ts)
ALTER TABLE `audit_log`
  ADD COLUMN `prev_hash` CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `row_hash`  CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `hash_at`   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD INDEX  `idx_audit_t_hash_at` (`tenant_id`, `hash_at`);

-- 2. call_window_audit (C01/F02 amendment; partitioned by created_at)
ALTER TABLE `call_window_audit`
  ADD COLUMN `prev_hash` CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `row_hash`  CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `hash_at`   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD INDEX  `idx_cwa_t_hash_at` (`tenant_id`, `hash_at`);

-- 3. originate_audit (T04/F02 amendment; partitioned by originated_at)
ALTER TABLE `originate_audit`
  ADD COLUMN `prev_hash` CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `row_hash`  CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `hash_at`   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD INDEX  `idx_originate_audit_t_hash_at` (`tenant_id`, `hash_at`);

-- 4. consent_log (C02 table — created here since C02 hasn't shipped yet)
-- consent_log is INSERT-only, non-partitioned in Phase 1 (small volume).
CREATE TABLE IF NOT EXISTS `consent_log` (
    `id`                    BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id`             BIGINT NOT NULL DEFAULT 1,
    `call_uuid`             VARCHAR(64) NOT NULL,
    `lead_id`               BIGINT NOT NULL,
    `phone_e164`            VARCHAR(16) NOT NULL,
    `prompt_id`             VARCHAR(64) NOT NULL,
    `dtmf_response`         VARCHAR(8) NULL,
    `outcome`               ENUM('accepted','declined','timeout','error') NOT NULL,
    `language`              VARCHAR(8) NOT NULL DEFAULT 'en',
    `prompt_played_at`      DATETIME(6) NOT NULL,
    `prev_hash`             CHAR(64) NOT NULL DEFAULT '',
    `row_hash`              CHAR(64) NOT NULL DEFAULT '',
    `hash_at`               DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `created_at`            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (`id`),
    INDEX `idx_consent_t_call_uuid` (`tenant_id`, `call_uuid`),
    INDEX `idx_consent_t_lead_ts` (`tenant_id`, `lead_id`, `created_at`),
    INDEX `idx_consent_t_hash_at` (`tenant_id`, `hash_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5. dnc_sync_log (D05/F02 amendment; partitioned by started_at)
ALTER TABLE `dnc_sync_log`
  ADD COLUMN `prev_hash` CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `row_hash`  CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN `hash_at`   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD INDEX  `idx_dnc_sync_t_hash_at` (`hash_at`);
