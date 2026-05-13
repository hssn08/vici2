-- D07 — Lead-List Management schema amendments
-- Additive only; no DROP, no ALTER existing columns.

-- 1. Add owner_user_id and settings to lists
ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT NULL AFTER description,
  ADD COLUMN IF NOT EXISTS settings JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER owner_user_id;

-- Index for owner_user_id lookups
CREATE INDEX IF NOT EXISTS idx_lists_t_owner
  ON lists (tenant_id, owner_user_id);

-- 2. Add active toggle to campaign_lists (allows per-campaign disable without unlinking)
ALTER TABLE campaign_lists
  ADD COLUMN IF NOT EXISTS active TINYINT(1) NOT NULL DEFAULT 1 AFTER priority;
