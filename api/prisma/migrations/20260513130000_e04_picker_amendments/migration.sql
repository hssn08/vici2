-- E04 picker amendments (feat/F02-amendments — additive only, no DROP).
--
-- E04.1  campaigns.lead_lock_ttl_seconds
--   The SET NX EX fence-token TTL that prevents double-dial for the same lead.
--   Distinct from E01.3's lock_ttl_sec (the ZPOPMIN hopper-lock TTL).
--   Default 30 s = T04 pipeline (~10 ms) + T01 ESL roundtrip (~50 ms)
--   + ring timeout (22 s default) + 7 s safety margin.
--   M02 validator: value >= dial_timeout_sec + 5.
--
-- E04.2  campaigns.call_strategy
--   ENUM matching picker.CallStrategy Go type.
--   Phase 2 ships only longest_wait; column exists for Phase 3 strategies.
--   Intentionally additive alongside the legacy next_agent_call field; a future
--   migration (Phase 3) will unify the two columns.

ALTER TABLE `campaigns`
  ADD COLUMN `lead_lock_ttl_seconds` INT          NOT NULL DEFAULT 30
      COMMENT 'E04: fence-token TTL seconds for double-dial prevention. Default 30.',
  ADD COLUMN `call_strategy`         ENUM('longest_wait','random','fewest_calls','rank')
                                     NOT NULL DEFAULT 'longest_wait'
      COMMENT 'E04: agent-selection strategy for PROGRESSIVE dial.';
