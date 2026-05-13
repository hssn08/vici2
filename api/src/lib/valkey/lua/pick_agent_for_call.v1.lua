-- F04 PLAN §6.4 — pick_agent_for_call.v1.lua
--
-- Atomically pick the longest-waiting READY agent in a campaign and
-- transition them to RESERVED. Race-safe across N dialer instances
-- and N concurrent answered customer calls.
--
-- KEYS[1] = agents-by-campaign-READY ZSET   e.g. t:1:agents:by_campaign:{42}:by_status:READY
-- KEYS[2] = agents-by-status-READY ZSET     e.g. t:1:agents:by_status:READY (global per-tenant)
-- KEYS[3] = agents-by-campaign-RESERVED     e.g. t:1:agents:by_campaign:{42}:by_status:RESERVED
-- KEYS[4] = agents-by-status-RESERVED       e.g. t:1:agents:by_status:RESERVED
-- KEYS[5] = agent HASH key prefix           e.g. t:1:agent:  (concat with user_id)
-- ARGV[1] = call_uuid
-- ARGV[2] = ts_ms
--
-- Returns: user_id (string) or nil (no READY agent)

local picked = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #picked == 0 then
  return nil
end
local user_id = picked[1]

-- Atomic state transition: remove from READY indexes, add to RESERVED indexes
redis.call('ZREM', KEYS[1], user_id)
redis.call('ZREM', KEYS[2], user_id)
redis.call('ZADD', KEYS[3], tonumber(ARGV[2]), user_id)
redis.call('ZADD', KEYS[4], tonumber(ARGV[2]), user_id)

-- Update agent hash
local agent_key = KEYS[5] .. user_id
redis.call('HSET', agent_key,
  'status', 'RESERVED',
  'call_uuid', ARGV[1],
  'last_change_at', ARGV[2])

return user_id
