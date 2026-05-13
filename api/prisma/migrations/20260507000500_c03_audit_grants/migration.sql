-- =============================================================================
-- C03 — audit_grants
-- Extends grant discipline to sister tables + creates vici2_audit_reader and
-- vici2_partition_admin users.
--
-- vici2_app already has UPDATE/DELETE revoked on audit_log (F02 migration
-- 20260506201700_audit_grants). Here we:
--   (a) Revoke UPDATE/DELETE/DROP/ALTER/INDEX/REFERENCES/CREATE/TRUNCATE from
--       vici2_app on the four new immutable tables + audit_attestation.
--   (b) Create vici2_audit_reader with SELECT-only on all six tables.
--   (c) Create vici2_partition_admin with ALTER,DROP on the five partitioned
--       tables only (for C04 rotation via DROP PARTITION).
--
-- Passwords come from environment variables at runtime; the CREATE USER uses
-- IDENTIFIED BY '' as a placeholder. In production, run:
--   ALTER USER 'vici2_audit_reader'@'%' IDENTIFIED BY '<secret>';
--   ALTER USER 'vici2_partition_admin'@'%' IDENTIFIED BY '<secret>';
-- from the infra/mysql/init/02-audit-users.sql script (which reads from env).
--
-- IF NOT EXISTS guard makes this idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (a) Tighten vici2_app on sister tables + audit_attestation
-- ---------------------------------------------------------------------------
-- call_window_audit
REVOKE UPDATE, DELETE, DROP, ALTER, `INDEX`, REFERENCES, CREATE, TRUNCATE
       ON `vici2`.`call_window_audit` FROM 'vici2_app'@'%';

-- originate_audit
REVOKE UPDATE, DELETE, DROP, ALTER, `INDEX`, REFERENCES, CREATE, TRUNCATE
       ON `vici2`.`originate_audit` FROM 'vici2_app'@'%';

-- consent_log
REVOKE UPDATE, DELETE, DROP, ALTER, `INDEX`, REFERENCES, CREATE, TRUNCATE
       ON `vici2`.`consent_log` FROM 'vici2_app'@'%';

-- dnc_sync_log
REVOKE UPDATE, DELETE, DROP, ALTER, `INDEX`, REFERENCES, CREATE, TRUNCATE
       ON `vici2`.`dnc_sync_log` FROM 'vici2_app'@'%';

-- audit_attestation
REVOKE UPDATE, DELETE, DROP, ALTER, `INDEX`, REFERENCES, CREATE, TRUNCATE
       ON `vici2`.`audit_attestation` FROM 'vici2_app'@'%';

-- Ensure INSERT + SELECT are still present (GRANT IF NOT already)
GRANT SELECT, INSERT ON `vici2`.`call_window_audit`  TO 'vici2_app'@'%';
GRANT SELECT, INSERT ON `vici2`.`originate_audit`    TO 'vici2_app'@'%';
GRANT SELECT, INSERT ON `vici2`.`consent_log`        TO 'vici2_app'@'%';
GRANT SELECT, INSERT ON `vici2`.`dnc_sync_log`       TO 'vici2_app'@'%';
GRANT SELECT, INSERT ON `vici2`.`audit_attestation`  TO 'vici2_app'@'%';

-- originate_audit: one-shot UPDATE is still required by T04 DAL
GRANT UPDATE ON `vici2`.`originate_audit` TO 'vici2_app'@'%';

-- ---------------------------------------------------------------------------
-- (b) vici2_audit_reader — SELECT-only on all audit tables
-- ---------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'vici2_audit_reader'@'%' IDENTIFIED BY '';

GRANT SELECT ON `vici2`.`audit_log`          TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`call_window_audit`  TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`originate_audit`    TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`consent_log`        TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`dnc_sync_log`       TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`audit_attestation`  TO 'vici2_audit_reader'@'%';
-- For verifier TZ resolution
GRANT SELECT ON `vici2`.`state_holidays`     TO 'vici2_audit_reader'@'%';
GRANT SELECT ON `vici2`.`phone_codes`        TO 'vici2_audit_reader'@'%';

-- ---------------------------------------------------------------------------
-- (c) vici2_partition_admin — ALTER + DROP on partitioned audit tables only
--     (needed for C04 DROP PARTITION; TRUNCATE requires DROP + DML which
--     this user does NOT have, preventing accidental full wipe)
-- ---------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'vici2_partition_admin'@'%' IDENTIFIED BY '';

GRANT ALTER, DROP ON `vici2`.`audit_log`         TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON `vici2`.`call_window_audit` TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON `vici2`.`originate_audit`   TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON `vici2`.`consent_log`       TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON `vici2`.`dnc_sync_log`      TO 'vici2_partition_admin'@'%';

FLUSH PRIVILEGES;
