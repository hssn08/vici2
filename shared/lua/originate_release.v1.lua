-- F04 (supports T04 5-gate originate audit) — originate_release.v1.lua
--
-- Atomic counter decrement + in-flight HASH delete on
-- CHANNEL_HANGUP_COMPLETE. Idempotent: if the in-flight HASH is already
-- gone (duplicate hangup event, janitor swept), we do NOT double-decrement
-- the gateway counter.
--
-- KEYS[1] = gateway active counter   e.g. t:1:gw:7:active
-- KEYS[2] = in-flight HASH           e.g. t:1:in_flight:{call_uuid}
-- ARGV[1] = call_uuid (validation: HASH must contain this call_uuid)
--
-- Returns:
--   {"OK", new_active_count}       — released; counter decremented (floor 0)
--   {"NOOP", current_active}       — in-flight HASH already gone; idempotent

local exists = redis.call('EXISTS', KEYS[2])
if exists == 0 then
  local active = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {'NOOP', tostring(active)}
end

local stored_uuid = redis.call('HGET', KEYS[2], 'call_uuid')
if stored_uuid and stored_uuid ~= ARGV[1] then
  -- HASH key collision (should not happen — call_uuid is in the key) — refuse
  return {'NOOP', tostring(tonumber(redis.call('GET', KEYS[1]) or '0'))}
end

redis.call('DEL', KEYS[2])

-- DECR with floor 0 (defensive; counter drift is reconciled by T02 reconciler)
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local new_active
if current <= 0 then
  redis.call('SET', KEYS[1], '0')
  new_active = 0
else
  new_active = redis.call('DECR', KEYS[1])
  if new_active < 0 then
    redis.call('SET', KEYS[1], '0')
    new_active = 0
  end
end

return {'OK', tostring(new_active)}
