-- =============================================================================
-- vici2 MySQL initial bootstrap.
-- Bind-mounted at /docker-entrypoint-initdb.d/01-databases.sql by
-- docker-compose.dev.yml. Runs ONCE when the MySQL data dir is first
-- created (subsequent container starts skip this file).
--
-- Per F02 PLAN §4.5 / §8 / §13:
--   vici2_app    — runtime user; INSERT+SELECT only on audit_log,
--                  full DML on every other table.
--   vici2_backup — read-only + LOCK TABLES (mysqldump shape; O02 owner).
--   vici2_root   — schema owner; runs Prisma migrations.
--
-- The official mysql Docker image has already created:
--   - the database in MYSQL_DATABASE env
--   - the MYSQL_USER@'%' user with ALL on MYSQL_DATABASE
--   - root@'%' with the MYSQL_ROOT_PASSWORD
-- We add the backup + root-runtime users and tighten the app user's
-- audit_log grant.
--
-- Idempotent: safe to re-run (CREATE USER IF NOT EXISTS is a no-op).
-- =============================================================================

-- backup user (mysqldump-shaped)
CREATE USER IF NOT EXISTS 'vici2_backup'@'%' IDENTIFIED BY 'change-me-backup-password';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, RELOAD, REPLICATION CLIENT
    ON *.* TO 'vici2_backup'@'%';

-- migrations / partition rotator user
CREATE USER IF NOT EXISTS 'vici2_root'@'%' IDENTIFIED BY 'change-me-root-runtime-password';
GRANT ALL PRIVILEGES ON `vici2`.* TO 'vici2_root'@'%';
GRANT ALL PRIVILEGES ON `vici2_dev`.* TO 'vici2_root'@'%';
GRANT ALL PRIVILEGES ON `vici2_test`.* TO 'vici2_root'@'%';

-- The MYSQL_USER (vici2_app per .env.example) already has ALL DML grants.
-- The audit_log INSERT-only narrowing is performed by the Prisma
-- migration 20260506201700_audit_grants AFTER the audit_log table
-- exists — chicken-and-egg if we tried to REVOKE here.

FLUSH PRIVILEGES;
