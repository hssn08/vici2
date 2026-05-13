-- R02 schema amendment §6 — recording upload pipeline columns
-- recording_log: add sha256 BINARY(32), lifecycle_state ENUM(9), failure_reason VARCHAR(64)
-- recordings:    add deletion_pending BOOLEAN + sweep index

-- ---------------------------------------------------------------------------
-- 1. Add RecordingLogLifecycle ENUM + new columns to recording_log
-- ---------------------------------------------------------------------------

ALTER TABLE `recording_log`
  ADD COLUMN `sha256` BINARY(32) NULL AFTER `storage_url`,
  ADD COLUMN `lifecycle_state` ENUM(
    'recording_complete',
    'uploading',
    'uploaded',
    'available',
    'failed',
    'corrupt',
    'consent_declined_no_upload',
    'orphan',
    'too_short'
  ) NOT NULL DEFAULT 'recording_complete' AFTER `sha256`,
  ADD COLUMN `failure_reason` VARCHAR(64) NULL AFTER `lifecycle_state`;

CREATE INDEX `idx_recording_log_t_lifecycle`
  ON `recording_log` (`tenant_id`, `lifecycle_state`);

-- ---------------------------------------------------------------------------
-- 2. Add deletion_pending to recordings + sweeper composite index
-- ---------------------------------------------------------------------------

ALTER TABLE `recordings`
  ADD COLUMN `deletion_pending` TINYINT(1) NOT NULL DEFAULT 0 AFTER `legal_hold`;

CREATE INDEX `idx_recordings_sweep`
  ON `recordings` (`tenant_id`, `deletion_pending`, `lifecycle_state`, `updated_at`);
