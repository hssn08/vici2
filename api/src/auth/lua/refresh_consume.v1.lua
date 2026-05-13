-- F05 refresh-token atomic consume + family-revoke (PLAN §2.2).
--
-- KEYS[1] = t:{tid}:auth:refresh:{family_id}:{token_hash}
-- KEYS[2] = t:{tid}:auth:refresh:family:{family_id}
-- KEYS[3] = t:{tid}:auth:refresh:user:{user_id}  (or "" if unknown)
-- ARGV[1] = family_id
--
-- Returns:
--   {"OK", user_id, tenant_id, family_id, role, parent_token_hash, expires_at}
--   {"REUSE_DETECTED", family_id, n_keys_revoked}
--   {"NOT_FOUND"}
--
-- token_hash is fixed 64 hex chars (SHA-256). Key suffix == token_hash.

local rec = redis.call('HGETALL', KEYS[1])
if #rec > 0 then
  local h = {}
  for i = 1, #rec, 2 do h[rec[i]] = rec[i + 1] end
  local key = KEYS[1]
  local token_hash = string.sub(key, string.len(key) - 63)
  redis.call('DEL', key)
  redis.call('SREM', KEYS[2], token_hash)
  return {'OK', h.user_id or '', h.tenant_id or '', h.family_id or '',
          h.role or '', h.parent_token_hash or '', h.expires_at or ''}
end

local family_size = redis.call('SCARD', KEYS[2])
if family_size > 0 then
  local members = redis.call('SMEMBERS', KEYS[2])
  local prefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - 64)
  local deleted = 0
  for i = 1, #members do
    deleted = deleted + redis.call('DEL', prefix .. members[i])
  end
  redis.call('DEL', KEYS[2])
  if KEYS[3] ~= '' then
    redis.call('SREM', KEYS[3], ARGV[1])
  end
  return {'REUSE_DETECTED', ARGV[1], tostring(deleted)}
end

return {'NOT_FOUND'}
