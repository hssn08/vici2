-- F04 PLAN §6.3 — record_call_outcome.v1.lua
--
-- Atomically write a call outcome to the campaign drop_window and the
-- cross-cutting events stream, and clear in-flight tracking.
-- Either both writes succeed or neither does (preserves drop% accuracy).
--
-- KEYS[1] = drop_window stream    e.g. t:1:campaign:{42}:drop_window
-- KEYS[2] = events stream         e.g. events:vici2.call.<answered|dropped|ended>
-- KEYS[3] = in-flight HASH        e.g. t:1:campaign:{42}:in_flight
-- KEYS[4] = active call HASH      e.g. t:1:call:{uuid}
-- KEYS[5] = active calls SET      e.g. t:1:call:active
-- KEYS[6] = per-campaign active SET  e.g. t:1:campaign:{42}:active_calls
-- ARGV[1] = answered (0|1)
-- ARGV[2] = dropped  (0|1)
-- ARGV[3] = ts_ms
-- ARGV[4] = call_uuid
-- ARGV[5] = lead_id
-- ARGV[6] = campaign_id
-- ARGV[7] = tenant_id
-- ARGV[8] = drop_window MAXLEN (e.g. "500000")
-- ARGV[9] = events MAXLEN (e.g. "1000000")
--
-- Returns: 'OK'

redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[8], '*',
  'answered', ARGV[1], 'dropped', ARGV[2],
  'ts', ARGV[3], 'call_uuid', ARGV[4])

redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[9], '*',
  'tenant_id', ARGV[7], 'campaign_id', ARGV[6],
  'call_uuid', ARGV[4], 'lead_id', ARGV[5],
  'answered', ARGV[1], 'dropped', ARGV[2], 'ts', ARGV[3])

-- Clear in-flight + active state
redis.call('HDEL', KEYS[3], ARGV[5])
redis.call('DEL',  KEYS[4])
redis.call('SREM', KEYS[5], ARGV[4])
redis.call('SREM', KEYS[6], ARGV[4])

return 'OK'
