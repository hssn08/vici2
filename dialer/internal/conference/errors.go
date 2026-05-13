package conference

import "errors"

// Sentinel errors returned by Operator methods.
// Callers should match with errors.Is to remain forward-compatible.
var (
	// ErrConfNotFound is returned when the agent's conference does not exist
	// in FreeSWITCH (agent not logged in / not yet in S3 IDLE).
	ErrConfNotFound = errors.New("conference: not found (agent not logged in)")

	// ErrAgentNotInConf is returned when EnsureAgentConfReady cannot confirm
	// the agent member within the confirmTimeout window.
	ErrAgentNotInConf = errors.New("conference: agent not in conference")

	// ErrLegNotInConf is returned by MemberIDForCall when neither the Valkey
	// HASH nor the uuid_getvar fallback can locate the leg's member-id.
	ErrLegNotInConf = errors.New("conference: leg not in conference")

	// ErrCustomerNotInConf is returned when a customer-targeted operation
	// (MuteCustomer, KickCustomer, HoldCustomer) finds no customer member.
	ErrCustomerNotInConf = errors.New("conference: no customer member in conference")

	// ErrAgentNotReady is returned when an operation that requires READY state
	// is called while the agent is in a different state. Authorization checks
	// belong to the API layer; this error is returned only for clear invariant
	// violations.
	ErrAgentNotReady = errors.New("conference: agent not in READY state")

	// ErrCrossTenant is returned when a tenantID mismatch is detected by the
	// server-side cross-tenant guard (§9.2 defense-in-depth).
	ErrCrossTenant = errors.New("conference: cross-tenant access denied")
)
