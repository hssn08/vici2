-- D05 — redeem_dnc_bypass.v1.lua (Go embed copy — canonical source is shared/lua/)
-- KEYS[1] = t:{tid}:dnc:bypass:{tokenHash}
-- ARGV[1] = expected payload "{phone}|{source}|{user_id}|{justification_hash}"
local v = redis.call('GETDEL', KEYS[1])
if not v then
  return nil
end
if v ~= ARGV[1] then
  return 'MISMATCH'
end
return 'OK'
