-- I01 down migration — reverses all changes from migration.sql.
-- Dev/test use only; never run in production.

-- Reverse §3.6 ALTER on ingroups
ALTER TABLE ingroups
  DROP COLUMN routing_strategy,
  DROP COLUMN sticky_enabled,
  DROP COLUMN sticky_window_hours,
  DROP COLUMN sticky_first_try_seconds,
  DROP COLUMN sticky_wait_during_wrapup,
  DROP COLUMN wrapup_seconds,
  DROP COLUMN recording_mode,
  DROP COLUMN recording_disclosure_audio,
  DROP COLUMN moh_stream,
  DROP COLUMN welcome_audio,
  DROP COLUMN position_announce_template,
  DROP COLUMN announce_interval_sec,
  DROP COLUMN announce_min_wait_sec,
  DROP COLUMN entry_full_action,
  DROP COLUMN entry_full_target,
  DROP COLUMN callback_offer_enabled,
  DROP COLUMN callback_offer_after_seconds,
  DROP COLUMN closed_action,
  DROP COLUMN closed_target,
  DROP COLUMN business_hours_id;

-- Reverse §3.5 ALTER on did_numbers
ALTER TABLE did_numbers
  DROP COLUMN priority_boost_seconds,
  DROP COLUMN crm_lookup_enabled,
  DROP COLUMN recording_disclosure_audio,
  DROP COLUMN business_hours_id;

-- Reverse §3.4 queue_log
DROP TABLE IF EXISTS queue_log;

-- Reverse §3.3 queue_calls
DROP TABLE IF EXISTS queue_calls;

-- Reverse §3.2 agent_skills
DROP TABLE IF EXISTS agent_skills;

-- Reverse §3.1 ingroup_skills
DROP TABLE IF EXISTS ingroup_skills;
