# vici2 — Event contract

Events flow over **Redis Streams** (live, ephemeral) and via **FreeSWITCH ESL**
(SIP-layer telemetry). JSON Schemas live under
[`shared/events/`](../shared/events/).

## Stream naming

`vici2.<domain>.<event>`

Examples (some delivered by later modules):

- `vici2.call.originated` — dialer started a leg
- `vici2.call.answered`   — leg picked up
- `vici2.call.bridged`    — customer leg joined agent conference
- `vici2.call.hangup`     — leg ended (with cause code)
- `vici2.agent.ready`     — agent moved to READY
- `vici2.lead.dispositioned` — disposition recorded

## Consumer groups

Per-service: `dialer`, `api`, `workers`, `realtime`. Each group reads its own
copy of the stream; XACK after processing.

## Versioning

Each schema lives at `shared/events/<event-name>.<version>.schema.json`. Add a
new file for breaking changes; keep emitting the old version for one release.

## ESL events

Listened to by both `dialer/` (Go) and `api/` (Node consumer). Subscriptions
filter to call-affecting events only (`CHANNEL_CREATE`, `CHANNEL_ANSWER`,
`CHANNEL_BRIDGE`, `CHANNEL_HANGUP_COMPLETE`, `CHANNEL_DESTROY`,
`CUSTOM conference::maintenance`, `CUSTOM callcenter::info`).

T01 (ESL bridge) owns the implementation; F01 only ensures the ESL listener
port is reachable from both containers.
