-- N07 schema amendment — transcript pipeline columns on recording_log
-- Adds TranscriptStatus enum + 4 columns + composite index.

-- ---------------------------------------------------------------------------
-- 1. Add TranscriptStatus ENUM + transcript columns to recording_log
-- ---------------------------------------------------------------------------

ALTER TABLE `recording_log`
  ADD COLUMN `transcript_uri`        VARCHAR(512)  NULL               AFTER `storage_url`,
  ADD COLUMN `transcript_status`     ENUM(
    'pending',
    'queued',
    'processing',
    'completed',
    'failed',
    'skipped',
    'consent_blocked'
  ) NOT NULL DEFAULT 'pending'                                         AFTER `transcript_uri`,
  ADD COLUMN `transcript_lang`       VARCHAR(16)   NULL               AFTER `transcript_status`,
  ADD COLUMN `transcript_word_count` INT           NULL               AFTER `transcript_lang`;

-- ---------------------------------------------------------------------------
-- 2. Composite index for queue-depth and status queries
-- ---------------------------------------------------------------------------

CREATE INDEX `idx_recording_log_t_transcript`
  ON `recording_log` (`tenant_id`, `transcript_status`, `start_time`);
