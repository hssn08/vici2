-- I05 — Voicemail Capture + VM Drop
-- Migration: 20260513280000_i05_voicemail_drop
-- NOTE: timestamp 280000 used (270000 collides with I04 + S05).

-- ─── New table: voicemail_drop_assets ─────────────────────────────────────────

CREATE TABLE voicemail_drop_assets (
  id              BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT        NOT NULL DEFAULT 1,
  name            VARCHAR(128)  NOT NULL
    COMMENT 'Human-readable label for this drop audio',
  s3_uri          VARCHAR(512)  DEFAULT NULL
    COMMENT 'S3 URI (canonical storage); NULL in Phase 1 local-only mode',
  local_path      VARCHAR(512)  NOT NULL
    COMMENT 'Absolute local FS path; used by FreeSWITCH uuid_broadcast at call time',
  duration_sec    SMALLINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Duration detected by ffprobe at upload time',
  size_bytes      INT UNSIGNED  NOT NULL DEFAULT 0,
  original_format VARCHAR(8)    NOT NULL DEFAULT 'wav'
    COMMENT 'Original upload format: wav | mp3',
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_by      BIGINT        NOT NULL
    COMMENT 'FK → users.id — admin who uploaded',
  created_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_vmda_tenant_name (tenant_id, name),
  INDEX idx_vmda_tenant_active (tenant_id, active),
  CONSTRAINT fk_vmda_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fk_vmda_created_by FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- ─── voicemail_boxes: add notify_email ────────────────────────────────────────

ALTER TABLE voicemail_boxes
  ADD COLUMN notify_email  VARCHAR(255) DEFAULT NULL
    COMMENT 'Optional team email; new-VM notification sent here in addition to boxUsers'
  AFTER max_duration_sec;

-- ─── voicemails: add partial flag ─────────────────────────────────────────────
-- NOTE: voicemails is partitioned; ALTER TABLE ADD COLUMN is an in-place
-- operation on MySQL 8 and does not rebuild the partition data.

ALTER TABLE voicemails
  ADD COLUMN partial TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = caller hung up before recording completed (duration_sec < 3)'
  AFTER caller_number;

-- ─── campaigns: add vmdrop_asset_id FK ────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN vmdrop_asset_id BIGINT DEFAULT NULL
    COMMENT 'FK → voicemail_drop_assets.id; used when amd_action=vmdrop'
  AFTER vmdrop_audio,
  ADD COLUMN vmdrop_requires_consent TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1 = consent gate blocks VM drop for cell numbers (TCPA); 0 = landline-only bypass'
  AFTER vmdrop_asset_id,
  ADD CONSTRAINT fk_camp_vmdrop_asset FOREIGN KEY (vmdrop_asset_id)
    REFERENCES voicemail_drop_assets(id) ON DELETE SET NULL ON UPDATE NO ACTION;
