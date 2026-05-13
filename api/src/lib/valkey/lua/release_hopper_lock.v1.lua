-- F04 PLAN §6.2 — release_hopper_lock.v1.lua
--
-- Idempotently release a hopper claim. Optionally re-add the lead to
-- the hopper (e.g., on originate failure that should retry).
--
-- KEYS[1] = lock key             e.g. t:1:lead_lock:{42}:12345
-- KEYS[2] = in-flight HASH       e.g. t:1:campaign:{42}:in_flight
-- KEYS[3] = hopper ZSET          e.g. t:1:campaign:{42}:hopper (only used if reinsert=1)
-- ARGV[1] = lead_id
-- ARGV[2] = "1" to reinsert, "0" to drop
-- ARGV[3] = score for reinsert (only used if reinsert=1)
-- ARGV[4] = expected lock value (instance_id:claim_ts) — fence against double-release
--
-- Returns: 1 if released, 0 if lock didn't match (no-op)

local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[4] then
  -- Lock was taken by someone else (we crashed and TTL fired); do nothing.
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[1])

if ARGV[2] == '1' then
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
end

return 1
