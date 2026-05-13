-- A06 Amendment A06.A1: auto-dial / predictive-mode agent UI campaign columns
-- Additive migration — safe to run on live data; DEFAULT values preserve
-- current behaviour (auto_ready=true, no preview window).

ALTER TABLE `campaigns`
  ADD COLUMN `auto_ready_after_wrapup` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'A06: auto-flip agent to READY after wrapup+dispo in auto-dial mode'
    AFTER `wrapup_seconds`,
  ADD COLUMN `preview_allowed_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'A06: seconds of lead preview before auto-bridge (0=disabled)'
    AFTER `auto_ready_after_wrapup`;
