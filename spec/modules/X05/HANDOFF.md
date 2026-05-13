# X05 — Local-Presence Caller-ID — HANDOFF

**Module:** X05 — Local-Presence Caller-ID
**Status:** STUB — to be completed after IMPLEMENT phase
**Date:** 2026-05-13

---

## 1. What Was Built

_Populated by IMPLEMENT agent._

## 2. Matching Algorithm Summary

The four-tier selection algorithm (exact NPA → neighbor NPA → same state →
X04 pool fallback) is implemented in:
- Go: `dialer/internal/originate/pick_caller.go` — `PickCallerID()`
- TypeScript: `api/src/services/number-pool/local-presence.ts` — `pickCallerIdWithLocalPresence()`

Enable local presence per pool by setting `local_presence_enabled = true` via
`PATCH /api/admin/number-pools/:id`.

## 3. Valkey Key Reference

| Key | Type | Owner | Description |
|---|---|---|---|
| `t:{tid}:pool:{pid}:npa:{npa}` | SET | X05 index builder | DID IDs for this NPA |
| `t:{tid}:pool:{pid}:state:{st}` | SET | X05 index builder | DID IDs for this state |
| `t:{tid}:pool:{pid}:npa_index_built` | STRING | X05 index builder | Sentinel; 24h TTL |
| `t:{tid}:pool-membership:events` | PubSub channel | X04 (write), X05 (read) | DID add/remove events |

## 4. How to Extend to International

Phase-1 covers NANP (US, Canada, Caribbean) only. To add international:
1. Add a country-code extraction path in `extractNPA()` for non-+1 numbers.
2. Add country-code SETs: `t:{tid}:pool:{pid}:cc:{cc}` (e.g. `:cc:44` for UK).
3. Extend the neighbor table concept to country-region level.
4. Update `isReservedNPA()` for non-NANP reserved ranges.

## 5. Neighbor NPA Table Updates

The neighbor NPA table is in `dialer/internal/originate/npa_neighbors.go`.
When NANPA assigns a new overlay NPA, update this file and redeploy the dialer.
Phase-2 plan: move to an admin-editable Valkey HASH (`t:0:npa_neighbors`) for
hot updates without redeployment.

## 6. Metrics

See PLAN.md §8 for Prometheus counter names and label values. The key metric
for operational monitoring is:

```
vici2_x05_match_tier_total{tier="pool_fallback"}
```

A sustained high rate of `pool_fallback` indicates insufficient DID inventory
for the calling population. Use the coverage report API to identify which NPAs
need additional DIDs.

## 7. Admin UI Integration Points

- `PATCH /api/admin/number-pools/:id` — enable/disable local presence
- `GET /api/admin/number-pools/:id/npa-coverage` — per-NPA DID count report
- Future: M08 will add coverage heatmap to the admin UI

## 8. Known Limitations

- Mobile number portability: a +1-415-NXX number may belong to a subscriber
  who has physically moved; the local-presence match is NPA-based, not
  geographic. This is the industry-standard caveat.
- STIR/SHAKEN A-attestation: Phase-1 does not prefer same-carrier DIDs.
  B-attestation may result when the matched DID is on a different carrier
  than the outbound trunk. Phase-2 work will add carrier-match preference.
- Neighbor NPA table is static and requires redeployment to update.
