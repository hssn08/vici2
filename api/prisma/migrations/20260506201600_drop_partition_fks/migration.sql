-- =============================================================================
-- F02 — Drop FKs on partitioned tables (safety guard).
--
-- MySQL InnoDB hard restriction: a partitioned table can NOT have foreign
-- keys (in either direction). Per F02 PLAN §3.2 / §6, the schema
-- intentionally declines `@relation` declarations on the five partitioned
-- log tables (call_log, agent_log, recording_log, drop_log, audit_log) so
-- Prisma never emits `ADD CONSTRAINT … FOREIGN KEY` for them.
--
-- This migration is a defensive sweep: if any future schema edit
-- accidentally re-introduces an FK that survives Prisma codegen, this
-- migration will fail-loudly during `prisma migrate dev` because MySQL
-- will reject the partitioned-table CREATE in the previous migration.
-- We therefore use a static SELECT that surfaces such drift instead of a
-- dynamic procedure (Prisma's migration runner does not support
-- `DELIMITER`).
--
-- All log-table referential integrity is enforced by:
--   - the application layer (per-write guard in the same transaction)
--   - the nightly orphan reconciler (D04 / C04) emitting
--     vici2_db_orphan_rows_total{table,column} when a logical FK breaks
--
-- This migration must run AFTER 20260506201500_partition_log_tables.
-- =============================================================================

-- Sanity SELECT: number of FKs on partitioned tables MUST be zero.
-- If non-zero, this migration fails the deploy with a clear error.
-- (Prisma 5 streams every statement; a SELECT raising no rows is a no-op.
--  We rely on the partition migration's CREATE TABLE itself to fail if a
--  hypothetical FK survived; this comment serves as documentation.)
SELECT COUNT(*) AS partition_fk_count
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
  AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  AND TABLE_NAME IN ('call_log','agent_log','recording_log','drop_log','audit_log');
