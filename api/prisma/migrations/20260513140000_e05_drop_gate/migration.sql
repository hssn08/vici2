-- E05 Drop-Gate Migration
-- F02 amendment: 4 new campaign cols + rename adaptive_drop_pct→drop_target_max
-- + drop_log.originator_attempt_uuid + extended DropReason enum
-- + drop_gate_transition_log table + CHECK constraint
--
-- FCC § 64.1200(a)(7): hard ceiling = 3.00%; CHECK constraint is the enforcer.

-- ---------------------------------------------------------------------------
-- 1. Rename adaptive_drop_pct → drop_target_max on campaigns
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  CHANGE COLUMN `adaptive_drop_pct` `drop_target_max` DECIMAL(4,2) NOT NULL DEFAULT 1.50;

-- ---------------------------------------------------------------------------
-- 2. Add new E05 columns to campaigns
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN `drop_target_soft`                   DECIMAL(4,2) NOT NULL DEFAULT 1.00
    COMMENT 'E05: soft-cap alert threshold (WARN only; no gate)',
  ADD COLUMN `drop_target_max_override`            DECIMAL(4,2) NULL DEFAULT NULL
    COMMENT 'E05: downward-only regulated-industry cap; must be <= drop_target_max',
  ADD COLUMN `recover_seconds`                     INT NOT NULL DEFAULT 300
    COMMENT 'E05: minimum dwell seconds before hard gate auto-releases (min 60)',
  ADD COLUMN `count_early_customer_hangup_as_drop` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'E05: count calls where customer hangs up < 2s as PDROP (conservative FCC default)';

-- ---------------------------------------------------------------------------
-- 3. CHECK constraint: FCC ceiling + threshold ordering + dwell minimum
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD CONSTRAINT chk_drop_targets CHECK (
    drop_target_max     <= 3.00
    AND drop_target_soft <= drop_target_max
    AND drop_target_max  > 0
    AND (drop_target_max_override IS NULL
         OR drop_target_max_override <= drop_target_max)
    AND recover_seconds >= 60
  );

-- ---------------------------------------------------------------------------
-- 4. Extend DropReason enum with E05 reasons
-- ---------------------------------------------------------------------------
-- MySQL ENUM: ALTER TABLE MODIFY COLUMN to add new values.
ALTER TABLE drop_log
  MODIFY COLUMN `drop_reason`
    ENUM('no_agent','timeout','queue_full',
         'customer_hangup_early','audio_missing','software_error')
    NOT NULL
    COMMENT 'E05: reason for abandonment; extended by F02 amendment';

-- ---------------------------------------------------------------------------
-- 5. Add originator_attempt_uuid to drop_log (forward-link to originate_audit)
-- ---------------------------------------------------------------------------
ALTER TABLE drop_log
  ADD COLUMN `originator_attempt_uuid` VARCHAR(40) NULL DEFAULT NULL
    COMMENT 'E05: forward-link to originate_audit.attempt_uuid (T04 one-UUID rule)'
  AFTER `safe_harbor_played`;

-- ---------------------------------------------------------------------------
-- 6. Create drop_gate_transition_log (partitioned RANGE COLUMNS on occurred_at)
-- ---------------------------------------------------------------------------
CREATE TABLE `drop_gate_transition_log` (
  `id`           BIGINT       NOT NULL AUTO_INCREMENT,
  `tenant_id`    BIGINT       NOT NULL,
  `campaign_id`  VARCHAR(32)  NOT NULL,
  `action`       VARCHAR(16)  NOT NULL   COMMENT '"engage" | "release"',
  `drop_pct`     DECIMAL(5,2) NOT NULL,
  `source`       VARCHAR(16)  NOT NULL   COMMENT '"auto" | "operator"',
  `operator_id`  BIGINT       NULL,
  `reason`       VARCHAR(255) NULL,
  `occurred_at`  DATETIME(6)  NOT NULL,
  `created_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`, `occurred_at`),
  KEY `idx_dgtl_t_camp_ts` (`tenant_id`, `campaign_id`, `occurred_at`)
)
ENGINE=InnoDB
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS(`occurred_at`) (
  PARTITION p_2026_01 VALUES LESS THAN ('2026-02-01 00:00:00.000000'),
  PARTITION p_2026_02 VALUES LESS THAN ('2026-03-01 00:00:00.000000'),
  PARTITION p_2026_03 VALUES LESS THAN ('2026-04-01 00:00:00.000000'),
  PARTITION p_2026_04 VALUES LESS THAN ('2026-05-01 00:00:00.000000'),
  PARTITION p_2026_05 VALUES LESS THAN ('2026-06-01 00:00:00.000000'),
  PARTITION p_2026_06 VALUES LESS THAN ('2026-07-01 00:00:00.000000'),
  PARTITION p_2026_07 VALUES LESS THAN ('2026-08-01 00:00:00.000000'),
  PARTITION p_2026_08 VALUES LESS THAN ('2026-09-01 00:00:00.000000'),
  PARTITION p_2026_09 VALUES LESS THAN ('2026-10-01 00:00:00.000000'),
  PARTITION p_2026_10 VALUES LESS THAN ('2026-11-01 00:00:00.000000'),
  PARTITION p_2026_11 VALUES LESS THAN ('2026-12-01 00:00:00.000000'),
  PARTITION p_2026_12 VALUES LESS THAN ('2027-01-01 00:00:00.000000'),
  PARTITION p_future  VALUES LESS THAN (MAXVALUE)
)
COMMENT 'E05: durable audit trail for drop-gate engage/release events (7-year TCPA retention via C04)';

-- ---------------------------------------------------------------------------
-- 7. Grants (read for replication user; no new row permissions needed)
-- ---------------------------------------------------------------------------
-- (C03/audit grant pattern — replication user already has REPLICATION SLAVE)
