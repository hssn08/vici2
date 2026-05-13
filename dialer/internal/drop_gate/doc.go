// Package drop_gate implements the FCC § 64.1200(a)(7) safe-harbor drop-gate.
//
// # Overview
//
// E05 enforces the FCC Telephone Consumer Protection Act predictive-dialer
// safe-harbor requirement: no more than 3% of live-answered telemarketing calls
// may be abandoned over a rolling 30-day window per campaign. Parallel
// jurisdiction: FTC 16 CFR § 310.4(b)(4)(i) (Telemarketing Sales Rule).
//
// # Architecture
//
// Three loci:
//
//  1. Rolling-window calculator: a 15-s Go ticker reads MySQL (authoritative)
//     and publishes Valkey gauges consumed by E02, E03, T04, and S01.
//
//  2. Gate publisher: writes/deletes the t:{tid}:campaign:{cid}:drop_gated
//     Valkey STRING that E02's clamp #3 reads on every 1-Hz tick.
//
//  3. Reconciler: validates the Valkey drop_window STREAM against MySQL
//     drop_log every 60 s; drift > 1% → fail-closed (gate engaged).
//
// # Thresholds
//
// Default: soft=1.00%, hard=1.50%, FCC ceiling=3.00% (CHECK constraint).
// Hysteresis: 1.00 pp. Dwell: 300 s (min 60 s, per-campaign configurable).
//
// # State machine
//
//	NORMAL → SOFT_BREACH → HARD_BREACH (with hysteresis on return)
//
// # Key contracts (FROZEN)
//
//   - drop_pct_30d STRING: "1.23" (decimal text)
//   - drop_gated STRING: "1" present = gated, absent = not gated (E02: EXISTS)
//   - drop_gate_transitions STREAM: {action, drop_pct, source, ts}
//
// # TCPA evidence
//
// Every drop event: drop_log INSERT + call_log UPDATE in one MySQL TX.
// Every gate transition: drop_gate_transition_log INSERT (7-year retention, C04).
package drop_gate
