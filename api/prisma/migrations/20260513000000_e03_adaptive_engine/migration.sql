-- E03 adaptive dial-level controller: 9 new columns on campaigns table.
-- PLAN §9.1 (FROZEN). Additive only; no data migration; MySQL online DDL.
-- All columns have defaults so existing rows are unaffected.

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS adaptive_intensity         TINYINT          NOT NULL DEFAULT 0
        COMMENT 'E03 §2.3: intensity modifier -20..+20 (multiplicative gain on step sizes)',
    ADD COLUMN IF NOT EXISTS adaptive_dl_diff_target    TINYINT          NOT NULL DEFAULT -1
        COMMENT 'E03 §7.4: Phase 3 differential target; E03 ignores in Phase 2',
    ADD COLUMN IF NOT EXISTS adapt_tick_seconds         SMALLINT UNSIGNED NOT NULL DEFAULT 15
        COMMENT 'E03 §4.5: per-campaign outer tick interval (5-60s)',
    ADD COLUMN IF NOT EXISTS hold_band_pp               DECIMAL(3,2)     NOT NULL DEFAULT 0.30
        COMMENT 'E03 §2.2: deadband half-width in percentage points (0.00-2.00)',
    ADD COLUMN IF NOT EXISTS warmup_min_answered        SMALLINT UNSIGNED NOT NULL DEFAULT 50
        COMMENT 'E03 §5.3: warm-up exit gate: minimum answered calls (Vicidial parity)',
    ADD COLUMN IF NOT EXISTS warmup_min_seconds         SMALLINT UNSIGNED NOT NULL DEFAULT 300
        COMMENT 'E03 §5.3: warm-up exit gate: minimum elapsed seconds',
    ADD COLUMN IF NOT EXISTS drop_gated_debounce_sec    SMALLINT UNSIGNED NOT NULL DEFAULT 30
        COMMENT 'E03 §4.4: fast-cut debounce window in seconds (0-300)',
    ADD COLUMN IF NOT EXISTS shift_start_local          TIME              NULL     DEFAULT NULL
        COMMENT 'E03 §3.2: local-time shift start for ADAPT_TAPERED mode',
    ADD COLUMN IF NOT EXISTS shift_end_local            TIME              NULL     DEFAULT NULL
        COMMENT 'E03 §3.2: local-time shift end for ADAPT_TAPERED mode';
