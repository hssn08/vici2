-- F04 PLAN §6.5 — agent_state_transition.v1.lua
--
-- Atomically transition an agent from one status to another, keeping
-- both global and per-campaign indexes consistent.
-- Validates the from-state to prevent invalid transitions (e.g.,
-- LOGOUT -> READY without re-login).
--
-- KEYS[1] = agent HASH                       e.g. t:1:agent:7
-- KEYS[2] = old global ZSET                  e.g. t:1:agents:by_status:READY
-- KEYS[3] = old per-campaign ZSET            e.g. t:1:agents:by_campaign:{42}:by_status:READY
-- KEYS[4] = new global ZSET                  e.g. t:1:agents:by_status:INCALL
-- KEYS[5] = new per-campaign ZSET            e.g. t:1:agents:by_campaign:{42}:by_status:INCALL
-- ARGV[1] = user_id
-- ARGV[2] = expected current status (or "" to skip check)
-- ARGV[3] = new status
-- ARGV[4] = ts_ms
-- ARGV[5..n] = optional extra HSET pairs (lead_id, call_uuid, pause_code, ...)
--
-- Returns: 1 on success, 0 if expected status didn't match (caller retries / errors)

if ARGV[2] ~= '' then
  local cur = redis.call('HGET', KEYS[1], 'status')
  if cur ~= ARGV[2] then
    return 0
  end
end

-- Remove from old indexes
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])

-- Add to new indexes
redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), ARGV[1])
redis.call('ZADD', KEYS[5], tonumber(ARGV[4]), ARGV[1])

-- Update HASH
local sets = {'status', ARGV[3], 'last_change_at', ARGV[4]}
for i = 5, #ARGV, 2 do
  table.insert(sets, ARGV[i])
  table.insert(sets, ARGV[i+1])
end
redis.call('HSET', KEYS[1], unpack(sets))

return 1
