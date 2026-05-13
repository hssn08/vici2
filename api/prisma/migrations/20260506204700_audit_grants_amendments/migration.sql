-- =============================================================================
-- F02 amendments — immutability triggers on new audit-style tables.
--
-- Mirrors 20260506201700_audit_grants which guards `audit_log` with BEFORE
-- UPDATE / BEFORE DELETE triggers that SIGNAL SQLSTATE '45000'. Partition
-- rotation by C04 uses DROP PARTITION (DDL) which does NOT fire row-level
-- triggers, so monthly retention remains possible.
--
-- Tables covered:
--   call_window_audit   INSERT-only (C01 §8.1 TCPA evidence; UPDATE+DELETE forbidden)
--   dnc_sync_log        INSERT-only (D05 §6.5 sync evidence; UPDATE+DELETE forbidden)
--   originate_audit     INSERT + one-shot UPDATE (T04 RESEARCH §7).
--                       DAL guards UPDATE WHERE outcome='OTHER' AND outcome_at IS NULL
--                       so a finalized row is never overwritten. The trigger here
--                       enforces this at the SQL layer: a BEFORE UPDATE trigger
--                       blocks any mutation where the OLD row already has a
--                       non-default outcome (i.e. outcome != 'OTHER') or a
--                       non-null outcome_at — effectively making finalization
--                       immutable. DELETE is fully forbidden.
--
-- NOT covered (intentional — mutable by design):
--   campaign_status_overrides  Admin-edited per-campaign overrides; full DML
--                              required. (Audit trail comes via audit_log.)
--   state_holidays             Admin-edited reference lookup (operator may
--                              correct a date or citation); full DML required.
--   dnc_sync_config            Per-source cron config; full DML required.
--   tenants.internal_dnc_retention_years  Column add only; no table-level gate.
--
-- Idempotency: DROP TRIGGER IF EXISTS first, then re-create. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- call_window_audit — INSERT-only (TCPA decision log, 4y retention)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `call_window_audit_no_update`;
CREATE TRIGGER `call_window_audit_no_update` BEFORE UPDATE ON `call_window_audit`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'call_window_audit is append-only; UPDATE is not permitted (C01 §8.1)';

DROP TRIGGER IF EXISTS `call_window_audit_no_delete`;
CREATE TRIGGER `call_window_audit_no_delete` BEFORE DELETE ON `call_window_audit`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'call_window_audit is append-only; DELETE is not permitted (C01 §8.1)';

-- -----------------------------------------------------------------------------
-- dnc_sync_log — INSERT-only (sync run summaries, 7y retention)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `dnc_sync_log_no_update`;
CREATE TRIGGER `dnc_sync_log_no_update` BEFORE UPDATE ON `dnc_sync_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'dnc_sync_log is append-only; UPDATE is not permitted (D05 §6.5)';

DROP TRIGGER IF EXISTS `dnc_sync_log_no_delete`;
CREATE TRIGGER `dnc_sync_log_no_delete` BEFORE DELETE ON `dnc_sync_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'dnc_sync_log is append-only; DELETE is not permitted (D05 §6.5)';

-- -----------------------------------------------------------------------------
-- originate_audit — INSERT + one-shot UPDATE (TCPA evidence, 7y retention)
--
-- A row is created BEFORE T01.Originate is called with outcome='OTHER',
-- outcome_at=NULL. After the BACKGROUND_JOB callback resolves the dispatch,
-- the DAL issues a single UPDATE that finalizes outcome + outcome_at. Once
-- finalized, the row is immutable.
--
-- The trigger below blocks any UPDATE where the OLD row is already finalized
-- (outcome != 'OTHER' OR outcome_at IS NOT NULL). Phase 1 callers MUST issue
-- exactly one UPDATE per row.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `originate_audit_one_shot_update`;
CREATE TRIGGER `originate_audit_one_shot_update` BEFORE UPDATE ON `originate_audit`
FOR EACH ROW
BEGIN
    IF OLD.outcome <> 'OTHER' OR OLD.outcome_at IS NOT NULL THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'originate_audit is one-shot UPDATE; row already finalized (T04 §7)';
    END IF;
END;

DROP TRIGGER IF EXISTS `originate_audit_no_delete`;
CREATE TRIGGER `originate_audit_no_delete` BEFORE DELETE ON `originate_audit`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'originate_audit is append-only; DELETE is not permitted (T04 §7)';
