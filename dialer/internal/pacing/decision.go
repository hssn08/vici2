// decision.go — pure Decider function: zero I/O, fully unit-testable.
//
// E02 PLAN §2.7: Vicidial-derived base formula + 4 clamps applied in order.
// Clamp ordering: (1) min_call_buffer, (2) carrier_headroom, (3) drop_gate,
// (4) ramp_up_rate.
package pacing

import "math"

// DecideResult carries the decision output plus per-clamp telemetry.
type DecideResult struct {
	Desired     int
	Base        int
	Level       float64
	AgentCount  int
	ClampsFired []string
}

// Decider holds metrics references for clamp tracking. It is safe for
// concurrent use; all state is in the Prometheus counters.
type Decider struct {
	m *Metrics
}

// NewDecider constructs a Decider with the given metrics handle.
func NewDecider(m *Metrics) *Decider {
	return &Decider{m: m}
}

// Decide computes desired_new_originates from the Valkey snapshot.
// E02 PLAN §2.7 — pure function.
func (d *Decider) Decide(snap Snapshot) DecideResult {
	res := DecideResult{}

	if snap.Config.DialMethod == DialMethodManual {
		return res // desired = 0; no dispatch tokens written
	}

	level := resolveLevel(snap)
	agents := resolveAgents(snap)

	res.Level = level
	res.AgentCount = agents

	// Base formula: max(0, round(agents × level) - active_calls).
	// round() = math.Round (half-away-from-zero); deliberate Vicidial departure.
	base := int(math.Round(float64(agents)*level)) - snap.ActiveCalls
	if base < 0 {
		base = 0
	}
	res.Base = base
	desired := base

	// ── Clamp 1: min_call_buffer ──────────────────────────────────────────────
	// Guard against E03 bugs shipping extreme dial_level to small campaigns.
	// Phase 2: avg_wait_to_answer_ms stubbed at 4000 ms (FCC 4-ring minimum).
	// Phase 3: real EWMA from E03.
	// E02 PLAN §2.3.
	if snap.AvgWaitToAnswerMs > 0 && agents > 0 {
		bufferMax := int(math.Floor(
			snap.Config.MinCallBufferSecs * 1000 * float64(agents) / float64(snap.AvgWaitToAnswerMs),
		))
		if desired > bufferMax {
			desired = bufferMax
			res.ClampsFired = append(res.ClampsFired, "buffer")
			if d.m != nil {
				d.m.ClampTotal.WithLabelValues(snap.Config.TenantIDStr(), snap.Config.CampaignID, "buffer").Inc()
			}
		}
	}

	// ── Clamp 2: carrier headroom ─────────────────────────────────────────────
	// E02 PLAN §2.4. GWHeadroom = -1 means no gateways → treat as unlimited.
	if snap.GWHeadroom >= 0 && desired > snap.GWHeadroom {
		desired = snap.GWHeadroom
		res.ClampsFired = append(res.ClampsFired, "gw")
		if d.m != nil {
			d.m.ClampTotal.WithLabelValues(snap.Config.TenantIDStr(), snap.Config.CampaignID, "gw").Inc()
		}
	}

	// ── Clamp 3: drop gate ────────────────────────────────────────────────────
	// E02 PLAN §2.5. E05 sets drop_gated STRING; we clamp to 1 (not 0) to
	// allow minimal dialing while recovery timer counts down.
	if snap.DropGated && desired > 1 {
		desired = 1
		res.ClampsFired = append(res.ClampsFired, "drop")
		if d.m != nil {
			d.m.ClampTotal.WithLabelValues(snap.Config.TenantIDStr(), snap.Config.CampaignID, "drop").Inc()
		}
	}

	// ── Clamp 4: ramp_up_rate ─────────────────────────────────────────────────
	// E02 PLAN §2.6. Prevents wake-up storm on shift-start.
	rampFactor := snap.Config.RampUpFactor
	if rampFactor < 1.0 {
		rampFactor = 2.0 // config_invalid_total incremented in config.go
	}
	rampMax := int(math.Ceil(level)) * int(math.Ceil(rampFactor))
	if rampMax < 1 {
		rampMax = 1
	}
	if desired > rampMax {
		desired = rampMax
		res.ClampsFired = append(res.ClampsFired, "ramp")
		if d.m != nil {
			d.m.ClampTotal.WithLabelValues(snap.Config.TenantIDStr(), snap.Config.CampaignID, "ramp").Inc()
		}
	}

	if desired < 0 {
		desired = 0
	}
	res.Desired = desired
	return res
}

