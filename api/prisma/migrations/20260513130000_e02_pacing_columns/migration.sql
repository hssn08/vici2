-- F02 Amendment A2/E02 — four pacing-engine columns on campaigns table.
-- E02 PLAN §11.1: additive migration; zero-downtime deploy on Phase 1 schema.
-- All columns have safe defaults; no existing rows or indexes are modified.

ALTER TABLE `campaigns`
  ADD COLUMN `calls_per_second`       SMALLINT UNSIGNED NOT NULL DEFAULT 5
      COMMENT 'Token-bucket CPS ceiling for E04 dispatch (E02 PLAN §11.1)',
  ADD COLUMN `ramp_up_factor`         DECIMAL(4,2)      NOT NULL DEFAULT 2.00
      COMMENT 'Multiplier for ramp_up_rate_clamp; prevents wake-up storms (E02 PLAN §2.6)',
  ADD COLUMN `min_call_buffer_seconds` DECIMAL(4,2)     NOT NULL DEFAULT 2.00
      COMMENT 'FCC 2-s safe-harbor buffer clamp minimum (E02 PLAN §2.3)',
  ADD COLUMN `pacing_tick_ms`         SMALLINT UNSIGNED NOT NULL DEFAULT 1000
      COMMENT 'Per-campaign tick interval in ms [200,5000] (E02 PLAN §3.1)';

-- CHECK constraints enforce the ranges documented in PLAN §11.1.
ALTER TABLE `campaigns`
  ADD CONSTRAINT `chk_campaigns_calls_per_second` CHECK (`calls_per_second` >= 1),
  ADD CONSTRAINT `chk_campaigns_ramp_up_factor`   CHECK (`ramp_up_factor` >= 1.00),
  ADD CONSTRAINT `chk_campaigns_min_call_buffer`  CHECK (`min_call_buffer_seconds` >= 0.50),
  ADD CONSTRAINT `chk_campaigns_pacing_tick_ms`   CHECK (`pacing_tick_ms` BETWEEN 200 AND 5000);
