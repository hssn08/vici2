-- I04 — Inbound Callback Queue
-- Migration: additive columns on callbacks + ingroups; new compound index
-- Branch: feat/I04-implement
-- Date: 2026-05-13

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extend callbacks table with I04 source discriminator + metadata columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE callbacks
  ADD COLUMN source
    ENUM('AGENT','GLOBAL','INBOUND')
    NOT NULL DEFAULT 'AGENT'
    COMMENT 'AGENT = D06 agent-scoped; GLOBAL = D06 global; INBOUND = I04 inbound queue callback'
    AFTER status,

  ADD COLUMN original_ingroup_id
    VARCHAR(32) NULL
    COMMENT 'FK: ingroups.id for the in-group that offered the callback (INBOUND only)'
    AFTER source,

  ADD COLUMN original_wait_seconds
    INT UNSIGNED NULL
    COMMENT 'Seconds caller waited in queue before accepting callback offer (INBOUND only)'
    AFTER original_ingroup_id,

  ADD COLUMN callback_number
    VARCHAR(20) NULL
    COMMENT 'E.164 or 10-digit NANP number to call back (may differ from lead.phone; INBOUND only)'
    AFTER original_wait_seconds,

  ADD COLUMN fired_at
    DATETIME(6) NULL
    COMMENT 'Timestamp when callback was successfully originated (PENDING->LIVE transition)'
    AFTER callback_number;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK from callbacks.original_ingroup_id to ingroups
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE callbacks
  ADD CONSTRAINT fk_callbacks_ingroup
    FOREIGN KEY (tenant_id, original_ingroup_id)
    REFERENCES ingroups(tenant_id, id)
    ON DELETE SET NULL ON UPDATE NO ACTION;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Compound index for I01 dispatcher PENDING INBOUND query
--    (tenant_id, original_ingroup_id, source, status, callback_at)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX idx_callbacks_t_ingroup_source_status
  ON callbacks (tenant_id, original_ingroup_id, source, status, callback_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Extend ingroups table with I04 callback-offer configuration columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE ingroups
  ADD COLUMN callback_offer_enabled
    BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'I01 queue-offer callback: operator opt-in (I04)',

  ADD COLUMN callback_offer_after_seconds
    INT UNSIGNED NOT NULL DEFAULT 90
    COMMENT 'Seconds caller must wait before callback offer is triggered (I04)',

  ADD COLUMN callback_number_mode
    ENUM('ani','dtmf_optional','dtmf_required') NOT NULL DEFAULT 'ani'
    COMMENT 'Phase 1: ani only; dtmf modes deferred to Phase 2 (I04)',

  ADD COLUMN outbound_cli
    VARCHAR(20) NULL
    COMMENT 'E.164 CLI to use as from-number when originating callback calls; falls back to tenant default (I04)',

  ADD COLUMN callback_no_answer_policy_inbound
    ENUM('leave_callbk','reschedule_30m','reschedule_24h','terminate_NA')
    NOT NULL DEFAULT 'reschedule_30m'
    COMMENT 'What to do when inbound callback is not answered by customer (I04)',

  ADD COLUMN callback_expires_hours
    SMALLINT UNSIGNED NOT NULL DEFAULT 96
    COMMENT 'Hours until a PENDING INBOUND callback is auto-expired by O02 (I04)',

  ADD COLUMN callback_position_expiry_minutes
    INT UNSIGNED NOT NULL DEFAULT 60
    COMMENT 'Minutes after which queue_position_at_offer priority degrades (I04)';
