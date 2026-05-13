-- I03 — Voicemail + Greetings migration
-- Adds: voicemail_boxes, voicemail_box_users, voicemails (partitioned)
-- Branch: feat/I03-implement
-- Date: 2026-05-13

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. voicemail_boxes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE voicemail_boxes (
  id                BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT        NOT NULL DEFAULT 1,
  name              VARCHAR(128)  NOT NULL,
  ingroup_id        VARCHAR(32)   DEFAULT NULL
    COMMENT 'FK to ingroups.id — mailbox for an in-group overflow',
  user_id           BIGINT        DEFAULT NULL
    COMMENT 'FK to users.id — personal agent mailbox',
  did_id            BIGINT        DEFAULT NULL
    COMMENT 'FK to did_numbers.id — DID-level mailbox',
  greeting_uri      VARCHAR(512)  DEFAULT NULL
    COMMENT 'Local or S3 URI for the custom greeting WAV; NULL = system default',
  max_duration_sec  SMALLINT UNSIGNED NOT NULL DEFAULT 120
    COMMENT 'Maximum recording length in seconds before auto-hangup',
  transcribe        TINYINT(1)    NOT NULL DEFAULT 0
    COMMENT 'When 1, emit events:vici2.transcription.requested after recording',
  active            TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_vmb_tenant_name (tenant_id, name),
  INDEX idx_vmb_tenant_active (tenant_id, active),
  CONSTRAINT fk_vmb_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. voicemail_box_users  (ACL join table)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE voicemail_box_users (
  voicemail_box_id  BIGINT  NOT NULL,
  user_id           BIGINT  NOT NULL,
  tenant_id         BIGINT  NOT NULL DEFAULT 1,
  created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (voicemail_box_id, user_id),
  INDEX idx_vmbu_tenant_user (tenant_id, user_id),
  CONSTRAINT fk_vmbu_box    FOREIGN KEY (voicemail_box_id)
    REFERENCES voicemail_boxes(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_vmbu_user   FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_vmbu_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. voicemails  (monthly partitioned)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: Foreign keys are NOT compatible with MySQL partitioned tables; the FK
-- to voicemail_boxes is enforced at the application layer.
CREATE TABLE voicemails (
  id              BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT        NOT NULL DEFAULT 1,
  mailbox_id      BIGINT        NOT NULL,
  call_uuid       VARCHAR(40)   NOT NULL,
  recording_uri   VARCHAR(512)  NOT NULL
    COMMENT 'Local path or S3 URI of the WAV recording',
  duration_sec    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  caller_number   VARCHAR(20)   DEFAULT NULL,
  status          ENUM('NEW','READ','ARCHIVED','DELETED') NOT NULL DEFAULT 'NEW',
  transcribed     TINYINT(1)    NOT NULL DEFAULT 0,
  transcript_uri  VARCHAR(512)  DEFAULT NULL,
  created_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id, created_at),
  INDEX idx_vm_tenant_mailbox_status (tenant_id, mailbox_id, status, created_at),
  INDEX idx_vm_tenant_created (tenant_id, created_at),
  INDEX idx_vm_call_uuid (tenant_id, call_uuid)
) PARTITION BY RANGE (TO_DAYS(created_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
);
