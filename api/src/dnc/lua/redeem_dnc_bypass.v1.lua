-- D05 — redeem_dnc_bypass.v1.lua
-- Atomic single-use bypass token redemption (PLAN §6.6).
--
-- KEYS[1] = t:{tid}:dnc:bypass:{tokenHash}
-- ARGV[1] = expected payload string "{phone}|{source}|{user_id}|{justification_hash}"
--
-- Returns:
--   'OK'       — token matched; key deleted (single-use enforced)
--   'MISMATCH' — key exists but payload mismatch (tampering or bug)
--   nil/false  — key missing or expired (TTL elapsed)

local v = redis.call('GETDEL', KEYS[1])
if not v then
  return nil
end
if v ~= ARGV[1] then
  return 'MISMATCH'
end
return 'OK'
