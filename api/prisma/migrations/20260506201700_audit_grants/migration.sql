-- =============================================================================
-- F02 — Audit_log immutability (INSERT-only).
--
-- Per F02 PLAN §4.5 / §8 / §13 the application user `vici2_app` must hold
-- ONLY {INSERT, SELECT} on `audit_log`.
--
-- Two enforcement layers, defence-in-depth:
--
-- 1. **Trigger gate** (this migration). BEFORE UPDATE and BEFORE DELETE
--    triggers on `audit_log` raise SIGNAL SQLSTATE '45000'. These fire
--    regardless of which DB user mutates the row — even root cannot
--    bypass them without first dropping the trigger. C03 owns the
--    higher-level event-emission contract; F02 owns the SQL-level gate.
--
-- 2. **Grant matrix** (lives in infra/mysql/init/01-databases.sql). The
--    runtime user `vici2_app` is granted enough DML to operate the rest
--    of the schema; for `audit_log` it gets the narrowest table-level
--    grant possible. Because MySQL takes the UNION of schema + table
--    grants, the trigger above is the load-bearing layer; the grant
--    matrix exists for auditability ("we configured the user to be
--    INSERT-only") and to keep mistakes loud.
--
-- Idempotency: DROP TRIGGER IF EXISTS first, then re-create. Safe to
-- re-run.
-- =============================================================================

-- BEFORE UPDATE: forbid any mutation of an existing row.
DROP TRIGGER IF EXISTS `audit_log_no_update`;
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'audit_log is append-only; UPDATE is not permitted (F02 §4.5)';

-- BEFORE DELETE: forbid removal of any row. Partition rotation by C04
-- runs DROP PARTITION, which does NOT fire row-level triggers, so
-- retention rotation remains possible.
DROP TRIGGER IF EXISTS `audit_log_no_delete`;
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'audit_log is append-only; DELETE is not permitted (F02 §4.5)';
