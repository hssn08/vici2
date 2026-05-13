-- D06 amendment D06.A1/A2/A3 — callback policy knobs on campaigns.
-- All three columns are additive (no DROP, no renames).

-- D06.A1  callback_no_answer_policy
ALTER TABLE campaigns
  ADD COLUMN callback_no_answer_policy
    ENUM('leave_callbk','reschedule_24h','terminate_NA')
    NOT NULL DEFAULT 'leave_callbk'
  AFTER recycle_delay_seconds;

-- D06.A2  callback_grace_window_seconds
ALTER TABLE campaigns
  ADD COLUMN callback_grace_window_seconds
    INT NOT NULL DEFAULT 30
  AFTER callback_no_answer_policy;

-- D06.A3  callback_stale_threshold_seconds
ALTER TABLE campaigns
  ADD COLUMN callback_stale_threshold_seconds
    INT NOT NULL DEFAULT 14400
  AFTER callback_grace_window_seconds;
