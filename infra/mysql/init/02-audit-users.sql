-- infra/mysql/init/02-audit-users.sql
-- Creates audit-specific DB users with passwords from environment variables.
-- Run at container init time (after migrations apply); idempotent.
--
-- Environment variables expected:
--   VICI2_AUDIT_READER_PASSWORD    — password for vici2_audit_reader
--   VICI2_PARTITION_ADMIN_PASSWORD — password for vici2_partition_admin
--
-- The migration 20260507000500_c03_audit_grants/migration.sql creates the
-- users with empty passwords (''). This script sets the real passwords from
-- env. In production, passwords come from AWS Secrets Manager / Vault.

CREATE USER IF NOT EXISTS 'vici2_audit_reader'@'%' IDENTIFIED BY '';
CREATE USER IF NOT EXISTS 'vici2_partition_admin'@'%' IDENTIFIED BY '';

-- Update passwords from env vars (interpolated by the init entrypoint script)
-- The Docker entrypoint replaces __AUDIT_READER_PW__ and __PARTITION_ADMIN_PW__
-- with the actual env values before executing this SQL.
ALTER USER 'vici2_audit_reader'@'%'   IDENTIFIED BY '__AUDIT_READER_PW__';
ALTER USER 'vici2_partition_admin'@'%' IDENTIFIED BY '__PARTITION_ADMIN_PW__';

-- Ensure grants are applied (migration may have run before user creation)
GRANT SELECT ON vici2.audit_log          TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.call_window_audit  TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.originate_audit    TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.consent_log        TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.dnc_sync_log       TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.audit_attestation  TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.state_holidays     TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.phone_codes        TO 'vici2_audit_reader'@'%';

GRANT ALTER, DROP ON vici2.audit_log         TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.call_window_audit TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.originate_audit   TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.consent_log       TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.dnc_sync_log      TO 'vici2_partition_admin'@'%';

FLUSH PRIVILEGES;
