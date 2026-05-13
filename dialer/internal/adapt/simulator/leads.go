// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package simulator

import "math/rand"

// LeadList models the lead answer process.
// Connect rate governs how many calls actually connect (answer).
// Baseline: Poisson calls attempted; connect_rate fraction answer.
type LeadList struct {
	ConnectRate float64 // fraction of dialed calls that connect (default 0.25)
	rng         *rand.Rand
}

// NewLeadList creates a LeadList with the given connect rate and seed.
func NewLeadList(connectRate float64, seed int64) *LeadList {
	if connectRate <= 0 || connectRate > 1 {
		connectRate = 0.25
	}
	return &LeadList{
		ConnectRate: connectRate,
		rng:         rand.New(rand.NewSource(seed)),
	}
}

// SimulateDials attempts 'n' dials and returns (answered, dropped).
// answered: calls that connected and were picked up by an agent.
// dropped: calls that connected but no agent was available (abandoned).
func (ll *LeadList) SimulateDials(n, readyAgents int, agents *AgentPool, now float64) (answered, dropped int) {
	for i := 0; i < n; i++ {
		// Does this dial connect?
		if ll.rng.Float64() >= ll.ConnectRate {
			continue // no answer
		}
		// Connected: is an agent available?
		if agents.AssignCall(now) {
			answered++
		} else {
			dropped++
		}
	}
	return
}
