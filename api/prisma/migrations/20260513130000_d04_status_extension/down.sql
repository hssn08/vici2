-- D04 — Status extension rollback (dev/test only)
-- WARNING: This will lose data in recycle_delay_seconds, category, system_owner columns.

ALTER TABLE statuses
  DROP CONSTRAINT chk_recycle_delay;

ALTER TABLE statuses
  DROP COLUMN `recycle_delay_seconds`,
  DROP COLUMN `category`,
  DROP COLUMN `system_owner`;

ALTER TABLE statuses
  MODIFY COLUMN `status` VARCHAR(8) NOT NULL;
