// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

// Package simulator provides a fast deterministic simulator for testing E03
// dial-level controller scenarios S1–S8 (PLAN §15.3).
//
// Agents are modeled with LogNormal AHT (μ=180s, σ=60s) per PLAN §11.3.
// All time is simulated: one "tick" = 15 real seconds of simulated time.
package simulator

import (
	"math"
	"math/rand"
)

// Agent models a call-center agent. AHT is LogNormal(μ=180s, σ=60s).
type Agent struct {
	id         int
	inCall     bool
	callEndsAt float64 // simulated seconds
}

// InCall returns true if the agent is currently on a call at simulated time 'now'.
func (a *Agent) InCall(now float64) bool {
	return a.inCall && a.callEndsAt > now
}

// AgentPool manages N agents with LogNormal AHT.
type AgentPool struct {
	Agents []*Agent
	rng    *rand.Rand
	muLN   float64 // log-normal μ parameter
	sigLN  float64 // log-normal σ parameter
}

// NewAgentPool creates an agent pool with N agents and LogNormal AHT.
// μ_AHT=180s, σ_AHT=60s → log-normal params: μ_ln=ln(μ²/√(μ²+σ²)), σ_ln=√(ln(1+σ²/μ²)).
func NewAgentPool(n int, seed int64) *AgentPool {
	muAHT := 180.0
	sigAHT := 60.0
	sigLN := math.Sqrt(math.Log(1 + (sigAHT*sigAHT)/(muAHT*muAHT)))
	muLN := math.Log(muAHT) - 0.5*sigLN*sigLN

	agents := make([]*Agent, n)
	for i := 0; i < n; i++ {
		agents[i] = &Agent{id: i}
	}
	return &AgentPool{
		Agents: agents,
		rng:    rand.New(rand.NewSource(seed)),
		muLN:   muLN,
		sigLN:  sigLN,
	}
}

// sampleAHT samples a call duration from LogNormal(μ_ln, σ_ln).
func (ap *AgentPool) sampleAHT() float64 {
	z := ap.rng.NormFloat64()
	return math.Exp(ap.muLN + ap.sigLN*z)
}

// ReadyCount returns the number of agents not currently in a call.
func (ap *AgentPool) ReadyCount(now float64) int {
	ready := 0
	for _, a := range ap.Agents {
		if !a.inCall || a.callEndsAt <= now {
			a.inCall = false
			ready++
		}
	}
	return ready
}

// AssignCall assigns a call to a ready agent. Returns false if no agent available.
func (ap *AgentPool) AssignCall(now float64) bool {
	for _, a := range ap.Agents {
		if !a.inCall || a.callEndsAt <= now {
			a.inCall = true
			a.callEndsAt = now + ap.sampleAHT()
			return true
		}
	}
	return false
}

// Resize changes the agent pool size (used for S4 agent-drop scenario).
func (ap *AgentPool) Resize(n int) {
	if n < len(ap.Agents) {
		// Mark excess agents as not in call (they log out).
		for i := n; i < len(ap.Agents); i++ {
			ap.Agents[i].inCall = false
		}
		ap.Agents = ap.Agents[:n]
	} else {
		for len(ap.Agents) < n {
			ap.Agents = append(ap.Agents, &Agent{id: len(ap.Agents)})
		}
	}
}
