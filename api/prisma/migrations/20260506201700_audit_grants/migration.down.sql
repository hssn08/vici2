-- Down migration for 20260506201700_audit_grants (dev/test only).
-- Removes the audit_log immutability triggers. Production must NEVER run
-- this — audit_log is forensic / TCPA evidence.
DROP TRIGGER IF EXISTS `audit_log_no_update`;
DROP TRIGGER IF EXISTS `audit_log_no_delete`;
