-- dispatch_inbound.v1.lua — Atomic inbound dispatch script.
--
-- I01 PLAN §6 (FROZEN).
-- Runs under redis.eval / evalsha. Atomically:
--   1. Verifies call still in queue (guard vs caller hangup race).
--   2. Verifies agent still READY in global pool (guard vs concurrent dispatch).
--   3. Removes call from ingroup queue ZSET.
--   4. Removes agent from ingroup ready ZSET.
--   5. Removes agent from global READY ZSET (E02 pacing race fix).
--   6. Adds agent to global INCALL ZSET.
--   7. Updates agent HASH: status=INCALL, call_uuid, ingroup_id, incall_since.
--   8. Updates call HASH: dispatch_at, dispatch_user_id.
--
-- KEYS[1]  t:{tid}:ingroup:{igid}:queue              (ZSET — waiting calls)
-- KEYS[2]  t:{tid}:ingroup:{igid}:ready_agents        (ZSET — ready agents for this ingroup)
-- KEYS[3]  t:{tid}:agents:by_status:READY             (global READY ZSET — E02 reads this)
-- KEYS[4]  t:{tid}:agents:by_status:INCALL            (global INCALL ZSET)
-- KEYS[5]  t:{tid}:agent:{user_id}                    (agent state HASH)
-- KEYS[6]  t:{tid}:queue_call:{call_uuid}             (call state HASH)
--
-- ARGV[1]=call_uuid  ARGV[2]=user_id  ARGV[3]=now_ms  ARGV[4]=ingroup_id

local call_uuid = ARGV[1]
local user_id   = ARGV[2]
local now_ms    = tonumber(ARGV[3])
local igid      = ARGV[4]

-- Verify call still in queue (guard against race with caller hangup)
local in_queue = redis.call('ZSCORE', KEYS[1], call_uuid)
if not in_queue then
  return redis.error_reply('CALL_NOT_IN_QUEUE')
end

-- Verify agent still READY in global pool
local in_ready = redis.call('ZSCORE', KEYS[3], user_id)
if not in_ready then
  return redis.error_reply('AGENT_NOT_READY')
end

-- Atomic state transition (8 operations)
redis.call('ZREM',  KEYS[1], call_uuid)          -- remove call from ingroup queue
redis.call('ZREM',  KEYS[2], user_id)            -- remove agent from ingroup ready pool
redis.call('ZREM',  KEYS[3], user_id)            -- remove agent from global READY (E02 boundary)
redis.call('ZADD',  KEYS[4], now_ms, user_id)    -- add agent to global INCALL
redis.call('HSET',  KEYS[5],
  'status',      'INCALL',
  'call_uuid',   call_uuid,
  'ingroup_id',  igid,
  'incall_since', tostring(now_ms))
redis.call('HSET',  KEYS[6],
  'dispatch_at',      tostring(now_ms),
  'dispatch_user_id', user_id)

return redis.status_reply('OK')
