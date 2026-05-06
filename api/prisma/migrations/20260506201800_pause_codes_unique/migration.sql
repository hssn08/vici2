-- =============================================================================
-- F02 — Functional UNIQUE on pause_codes (campaign_id NULL coalesced).
--
-- Per F02 PLAN §4.10: a pause code is unique within (tenant, campaign), but
-- a NULL campaign_id means "global / system default". MySQL's UNIQUE on
-- (tenant_id, campaign_id, code) treats every NULL as distinct, so two
-- "global" entries with the same code would slip past the constraint.
-- A functional UNIQUE on IFNULL(campaign_id, '__SYS__') closes the hole.
--
-- MySQL 8 supports functional indexes (8.0.13+). Prisma cannot express
-- this; raw SQL is required.
-- =============================================================================

CREATE UNIQUE INDEX `uk_pause_codes_t_camp_code`
    ON `pause_codes` (
        `tenant_id`,
        ((IFNULL(`campaign_id`, '__SYS__'))),
        `code`
    );
