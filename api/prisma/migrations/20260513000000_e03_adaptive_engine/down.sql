-- E03 rollback: remove the 9 adaptive engine columns (dev/test only).
-- WARNING: Do NOT run in production without operator review.

ALTER TABLE campaigns
    DROP COLUMN IF EXISTS adaptive_intensity,
    DROP COLUMN IF EXISTS adaptive_dl_diff_target,
    DROP COLUMN IF EXISTS adapt_tick_seconds,
    DROP COLUMN IF EXISTS hold_band_pp,
    DROP COLUMN IF EXISTS warmup_min_answered,
    DROP COLUMN IF EXISTS warmup_min_seconds,
    DROP COLUMN IF EXISTS drop_gated_debounce_sec,
    DROP COLUMN IF EXISTS shift_start_local,
    DROP COLUMN IF EXISTS shift_end_local;
