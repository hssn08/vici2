package conference

import "time"

// Role identifies the purpose of a conference member.
type Role string

const (
	RoleAgent      Role = "agent"
	RoleCustomer   Role = "customer"
	RoleThird      Role = "third"
	RoleSupervisor Role = "supervisor"
)

// Member is a snapshot of one conference participant at the time of the query.
type Member struct {
	MemberID  int
	CallUUID  string
	Role      Role
	CIDName   string
	CIDNumber string
	Flags     []string // "moderator", "mute", "deaf", "endconf", …
	JoinedAt  time.Time
	ConfName  string // "default" or "hold" (which conference the member is in)
}

// parseRole maps the vici2_role channel-var string to the typed Role enum.
// Unrecognised values map to RoleThird (safest default for non-agent legs).
func parseRole(s string) Role {
	switch s {
	case "agent_leg":
		return RoleAgent
	case "customer_leg":
		return RoleCustomer
	case "third_leg":
		return RoleThird
	case "supervisor_leg":
		return RoleSupervisor
	default:
		return RoleThird
	}
}
