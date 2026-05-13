# X03 — Multi-FS Campaign Affinity: Handoff

_Last updated: 2026-05-13 | Status: NOT_STARTED_

---

## Status

Not yet implemented. This is a stub for post-implementation handoff documentation.

## What to document here on completion

- Affinity model summary: how campaigns map to FS nodes (auto vs. manual pin).
- Rebalancer rules: when it fires, what it moves, what it skips (live campaigns).
- Ops procedures: adding a new FS node, draining a node, emergency re-pin.
- Kamailio set 20 maintenance: how to trigger resync (`dispatcher-list-renderer.py --action=sync`).
- ESL router: how to verify connection health (`vici2_esl_router_connections_total` metric).
- Known edge cases: multi-campaign agents; forced re-pin; FAILOVER_PENDING campaigns.
- Runbook: FS node replacement procedure (drain → failover → remove → add new → activate).
