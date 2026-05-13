-- D04 — Status extension migration (additive only)
--
-- Widens statuses.status from VARCHAR(8) to VARCHAR(24) to accommodate
-- GATEWAY_LIMIT_TRY_LATER (24 chars) per D04 PLAN §15.3 risk item.
-- Adds three new columns for recycle-delay semantics, category taxonomy,
-- and system-owner attribution.

ALTER TABLE statuses
  MODIFY COLUMN `status` VARCHAR(24) NOT NULL
    COMMENT 'Status code; widened from VARCHAR(8) to VARCHAR(24) for GATEWAY_LIMIT_TRY_LATER';

ALTER TABLE statuses
  ADD COLUMN `recycle_delay_seconds` INT NULL
      COMMENT 'NULL=campaign default, 0=immediate re-queue, -1=terminal, >0=seconds',
  ADD COLUMN `category` VARCHAR(20) NULL
      COMMENT 'agent-outcome|system-amd|system-carrier|system-compliance|lifecycle',
  ADD COLUMN `system_owner` VARCHAR(8) NULL
      COMMENT 'Which module emits this status: T04|T01|E01|E05|D06|__AGT__';

ALTER TABLE statuses
  ADD CONSTRAINT chk_recycle_delay
      CHECK (recycle_delay_seconds IS NULL
          OR recycle_delay_seconds = -1
          OR recycle_delay_seconds >= 0);
