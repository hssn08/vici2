-- F04 (cross-cuts D05) — dnc_bloom_check.v1.lua
--
-- Bloom-prefilter for DNC across one or more sources. Returns one bit per
-- source: 1 = Bloom-positive (caller must confirm via MySQL), 0 = clean.
-- Order of returned bits matches the order of supplied KEYS.
--
-- Bloom keys are passed as KEYS[]; the phone (E.164, no plus) is ARGV[1].
-- This script relies on the `valkey-bloom` module. If a Bloom key is
-- missing (`BF.EXISTS` against a non-existent key returns 0), we treat
-- the result as "clean" — D05 PLAN §1.5 says caller is responsible for
-- detecting the unavailable-module condition before calling this script.
--
-- KEYS[1..n] = Bloom filter keys (e.g. bf:dnc:federal, t:1:dnc:internal:bloom, ...)
-- ARGV[1]    = phone (E.164, e.g. "+14155551212")
--
-- Returns: array of "1"/"0" strings, same length as #KEYS.

local out = {}
for i = 1, #KEYS do
  local r = redis.call('BF.EXISTS', KEYS[i], ARGV[1])
  if r == 1 then
    out[i] = '1'
  else
    out[i] = '0'
  end
end
return out
