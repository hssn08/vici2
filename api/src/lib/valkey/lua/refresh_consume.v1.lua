-- F05 PLAN §2.2 — refresh_consume.v1.lua
--
-- Atomically consume a refresh token. If the token exists, delete it,
-- return the token record's user_id|tenant_id|family_id|role|parent_hash.
-- If the token is missing AND the family still exists, this is a REUSE
-- attack: revoke the entire family and return REUSE_DETECTED|family_id.
--
-- KEYS[1] = t:{tid}:auth:refresh:{family_id}:{token_hash}
-- KEYS[2] = t:{tid}:auth:refresh:family:{family_id}
-- KEYS[3] = t:{tid}:auth:refresh:user:{user_id}    -- optional (caller may pass "" if unknown)
-- ARGV[1] = family_id (string, used in the REUSE return)
--
-- Returns:
--   {"OK", user_id, tenant_id, family_id, role, parent_hash, expires_at}
--   {"REUSE_DETECTED", family_id, n_keys_revoked}
--   {"NOT_FOUND"}

local rec = redis.call('HGETALL', KEYS[1])
if #rec > 0 then
  -- Build a kv table from HGETALL flat list
  local h = {}
  for i = 1, #rec, 2 do h[rec[i]] = rec[i+1] end
  redis.call('DEL', KEYS[1])
  -- Last 64 chars of KEYS[1] is the token_hash hex
  redis.call('SREM', KEYS[2], string.sub(KEYS[1], string.len(KEYS[1]) - 63))
  return {'OK', h.user_id, h.tenant_id, h.family_id, h.role,
          h.parent_token_hash, h.expires_at}
end

-- Miss. Is the family still around?
local family_size = redis.call('SCARD', KEYS[2])
if family_size > 0 then
  -- Nuke every token in the family
  local members = redis.call('SMEMBERS', KEYS[2])
  for i = 1, #members do
    -- Reconstruct each per-token key by replacing the trailing token_hash
    -- portion of KEYS[1] with the member. KEYS[1] format is fixed:
    -- t:{tid}:auth:refresh:{family_id}:<token_hash>
    local prefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - 64)
    redis.call('DEL', prefix .. members[i])
  end
  redis.call('DEL', KEYS[2])
  if KEYS[3] ~= '' then
    redis.call('SREM', KEYS[3], ARGV[1])
  end
  return {'REUSE_DETECTED', ARGV[1], tostring(family_size)}
end

return {'NOT_FOUND'}
