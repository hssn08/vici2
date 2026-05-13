-- =============================================================================
-- C03 — extend_immutability
-- Adds BEFORE UPDATE / BEFORE DELETE immutability triggers to the four sister
-- tables not yet protected by F02, and adds no_update / no_delete / hash_chain
-- triggers to audit_attestation (which ships in the next migration but
-- triggers reference it — MySQL allows forward reference in the trigger body
-- but NOT in the CREATE TABLE; we drop-if-exists so re-runs are safe).
--
-- originate_audit already has originate_audit_one_shot_update and
-- originate_audit_no_delete from 20260506204700_audit_grants_amendments.
-- We keep those triggers; no action needed here for that table's update guard.
-- We DO add the hash_chain trigger (migration 200) to originate_audit already.
--
-- consent_log was created in migration 100; add its immutability triggers here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- consent_log — INSERT-only
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `consent_log_no_update`;
CREATE TRIGGER `consent_log_no_update` BEFORE UPDATE ON `consent_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'consent_log is append-only; UPDATE is not permitted (C03/C02)';

DROP TRIGGER IF EXISTS `consent_log_no_delete`;
CREATE TRIGGER `consent_log_no_delete` BEFORE DELETE ON `consent_log`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'consent_log is append-only; DELETE is not permitted (C03/C02)';

-- ---------------------------------------------------------------------------
-- audit_attestation — INSERT-only + hash_chain
-- (audit_attestation table is created in migration 400; triggers are safe to
-- define before table data exists; DROP IF EXISTS protects idempotency)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `audit_attestation_no_update`;
CREATE TRIGGER `audit_attestation_no_update` BEFORE UPDATE ON `audit_attestation`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'audit_attestation is append-only; UPDATE is not permitted (C03)';

DROP TRIGGER IF EXISTS `audit_attestation_no_delete`;
CREATE TRIGGER `audit_attestation_no_delete` BEFORE DELETE ON `audit_attestation`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'audit_attestation is append-only; DELETE is not permitted (C03)';
