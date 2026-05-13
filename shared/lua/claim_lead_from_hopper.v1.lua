-- F04 PLAN §6.1 — claim_lead_from_hopper.v1.lua
--
-- Atomically pop the lowest-score lead from a hopper, set an in-flight
-- lock + in-flight HASH entry, and return the lead_id.
--
-- KEYS[1] = hopper ZSET                        e.g. t:1:campaign:{42}:hopper
-- KEYS[2] = lead_lock prefix (string concat)   e.g. t:1:lead_lock:{42}:
-- KEYS[3] = in-flight HASH                     e.g. t:1:campaign:{42}:in_flight
-- ARGV[1] = lock TTL seconds (string int, e.g. "30")
-- ARGV[2] = dialer instance id
-- ARGV[3] = now_ms (string int)
--
-- Returns: lead_id (string) or nil (empty hopper)

local popped = redis.call('ZPOPMIN', KEYS[1], 1)
if #popped == 0 then
  return nil
end
local lead_id = popped[1]
-- popped[2] is the score (priority+ts); we discard it (caller can re-derive on push-back)

local lock_key = KEYS[2] .. lead_id
local lock_val = ARGV[2] .. ':' .. ARGV[3]

-- SET NX EX — if a stale lock somehow exists (shouldn't, since we just popped), don't overwrite
local ok = redis.call('SET', lock_key, lock_val, 'EX', tonumber(ARGV[1]), 'NX')
if not ok then
  -- Extremely unlikely: lock exists for a lead we just popped from a different angle.
  -- Push the lead back into the hopper at original-ish position and return nil.
  -- (Caller treats nil as "no work this tick"; janitor reconciles.)
  redis.call('ZADD', KEYS[1], popped[2], lead_id)
  return nil
end

-- Track in-flight for janitor / observability
redis.call('HSET', KEYS[3], lead_id, lock_val)

return lead_id
