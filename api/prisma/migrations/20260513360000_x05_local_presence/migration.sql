-- X05: Local-Presence Caller-ID
-- Migration: 20260513360000_x05_local_presence

-- 1. number_pools: add local_presence_enabled flag (X05 Amendment §2.1) -------

ALTER TABLE number_pools
  ADD COLUMN local_presence_enabled TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'X05: when true, prefer same-NPA DID before pool round-robin';

-- 2. originate_audit: add cid_match_tier for analytics (F02 Amendment F02.X05.1)

ALTER TABLE originate_audit
  ADD COLUMN cid_match_tier TINYINT UNSIGNED NULL
    COMMENT 'X05: 1=exact_npa 2=neighbor_npa 3=same_state 4=pool_fallback NULL=local_presence_disabled';
