// Package conference implements the T03 agent-conference primitives.
//
// ConferenceName / ConferenceFQN / HoldConferenceName are the ONLY places
// in the code-base allowed to assemble an "agent_*" conference name.
// A golangci-lint custom rule (tools/lints/agentprefix) enforces this.
//
// RFC-002 ACCEPTED — format: agent_t<tenantID>_u<userID>@<profile>.
package conference

import "fmt"

// ConferenceName returns the canonical conference name for an agent's
// per-agent conference, WITHOUT the profile suffix.
//
// Format: agent_t<tenantID>_u<userID>
//
// Phase 1: tenantID is always 1.
// Phase 4: tenantID comes from JWT claims / multi-tenant header.
func ConferenceName(tenantID, userID int64) string {
	return fmt.Sprintf("agent_t%d_u%d", tenantID, userID)
}

// ConferenceFQN returns the conference name with profile suffix, suitable
// for direct use in conference: URIs (e.g., uuid_transfer destinations).
//
//	ConferenceFQN(1, 1042, "default") → "agent_t1_u1042@default"
//	ConferenceFQN(1, 1042, "hold")    → "agent_t1_u1042@hold"
func ConferenceFQN(tenantID, userID int64, profile string) string {
	return ConferenceName(tenantID, userID) + "@" + profile
}

// HoldConferenceName returns the parking-conference name used during the
// hold UX (separate profile to enable MOH).
//
// Format: agent_t<tenantID>_u<userID>_hold
func HoldConferenceName(tenantID, userID int64) string {
	return fmt.Sprintf("agent_t%d_u%d_hold", tenantID, userID)
}
