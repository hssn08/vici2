// Package esl provides the FreeSWITCH ESL (Event Socket Library) transport
// layer for the vici2 dialer.
//
// # Architecture
//
// A single [Client] manages one persistent TCP connection per FreeSWITCH host,
// wrapping the percipia/eslgo library with the following additional concerns:
//
//   - Supervisor: exponential-backoff reconnect (300ms→30s, 25% jitter),
//     HEARTBEAT-based liveness, DEAD-host classification.
//   - Circuit breaker: per-FS, originate-only; 3 consecutive failures →
//     OPEN for 30s → HALF_OPEN probe → CLOSED.
//   - Rate limiting: per-FS and per-gateway token-bucket via Valkey Lua.
//   - Originate primitive: bgapi + pre-supplied Job-UUID + channel vars.
//   - UUID command set: Transfer, Bridge, Kill, Park, SetVar, Broadcast, Record.
//   - Conference commands: raw and typed (List, Kick, Mute, Hold).
//   - Event fan-out: 18-event allowlist → enriched EnrichedEvent → durable
//     Valkey Streams + low-latency pub/sub.
//   - Reconcile-on-reconnect: diff live FS channels vs Valkey active set.
//
// # T01 ↔ T04 boundary
//
// T01 is the *transport* layer — raw ESL commands with reconnect and circuit
// protection. T04 is the *compliance gate* (TCPA, DNC, recording consent,
// audit-log). T04 imports T01; T01 must never import T04.
//
// # Invariants (enforced by golangci-lint depguard)
//
//   - No import of github.com/vici2/dialer/internal/compliance or any T04 pkg.
//   - No import of database/sql or any ORM (DB writes are upstream worker's job).
//
// # References
//
//   - PLAN.md: T01 PLAN (frozen public surface)
//   - F03/HANDOFF.md: ESL port 8021, channel-var contract
//   - F04/HANDOFF.md: Valkey stream/key naming
package esl
