-- F04 (supports T04 5-gate originate audit) — originate_acquire.v1.lua
--
-- Atomic gateway-cap check + in-flight HASH write for one originate
-- attempt. T04 PLAN §11 specifies the contract: gate (1) gateway-cap
-- reads `t:{tid}:gw:{gid}:active`, compares to `gateways.max_concurrent`,
-- and on ALLOW writes the in-flight HASH `t:{tid}:in_flight:{call_uuid}`.
--
-- This script is the inner atomic on the ALLOW path. The caller has
-- already vetted the other 4 gates (drop_cap, tcpa, dnc, consent).
--
-- KEYS[1] = gateway active counter   e.g. t:1:gw:7:active                (STRING, INCR counter)
-- KEYS[2] = in-flight HASH           e.g. t:1:in_flight:{call_uuid}      (HASH)
-- ARGV[1] = max_concurrent           (string int)
-- ARGV[2] = call_uuid
-- ARGV[3] = lead_id
-- ARGV[4] = campaign_id
-- ARGV[5] = gateway_id
-- ARGV[6] = ts_ms
-- ARGV[7] = in_flight TTL seconds    (e.g. "60"; janitor cleans stale)
--
-- Returns:
--   {"OK", new_active_count}      — allowed; counter incremented
--   {"GATEWAY_LIMIT", current}    — blocked; counter NOT incremented

local active = tonumber(redis.call('GET', KEYS[1]) or '0')
local max_c  = tonumber(ARGV[1])

if active >= max_c then
  return {'GATEWAY_LIMIT', tostring(active)}
end

local new_active = redis.call('INCR', KEYS[1])

redis.call('HSET', KEYS[2],
  'call_uuid',   ARGV[2],
  'lead_id',     ARGV[3],
  'campaign_id', ARGV[4],
  'gateway_id',  ARGV[5],
  'started_at',  ARGV[6])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))

return {'OK', tostring(new_active)}
