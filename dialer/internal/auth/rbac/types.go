// Package rbac — RBAC decision types (M02 PLAN §3.1).
// Generated counterpart: matrix_gen.go (run `make gen-rbac`).
package rbac

// Role in the system.
type Role string

const (
	RoleSuperAdmin Role = "super_admin"
	RoleAdmin      Role = "admin"
	RoleSupervisor Role = "supervisor"
	RoleAgent      Role = "agent"
	RoleViewer     Role = "viewer"
	RoleIntegrator Role = "integrator"
)

// Scope predicate for a grant.
type Scope string

const (
	ScopeTenant Scope = "tenant"
	ScopeGroup  Scope = "group"
	ScopeOwn    Scope = "own"
	ScopeSelf   Scope = "self"
)

// Grant is a single cell in the role x verb matrix.
type Grant struct {
	Scope     Scope
	Sensitive bool
}

// DenyReason codes (mirrors TS DenyReason union).
type DenyReason string

const (
	DenyNoGrant                   DenyReason = "no_grant"
	DenyInactiveUser              DenyReason = "inactive_user"
	DenyTenantMismatch            DenyReason = "tenant_mismatch"
	DenyScopeGroup                DenyReason = "scope_group"
	DenyScopeOwn                  DenyReason = "scope_own"
	DenyScopeSelf                 DenyReason = "scope_self"
	DenyIntegratorKeyLacksPerm    DenyReason = "integrator_key_lacks_perm"
	DenyTotpRequiredNotVerified   DenyReason = "totp_required_not_verified"
	DenyCrossTenantNotAllowed     DenyReason = "cross_tenant_not_allowed"
	DenySystemError               DenyReason = "system_error"
)

// Decision is the output of Can().
type Decision struct {
	Allow     bool
	Sensitive bool       // only meaningful when Allow=true
	Reason    DenyReason // only meaningful when Allow=false
}

// AuthContext carries the caller's identity (pre-hydrated from JWT + cache).
type AuthContext struct {
	UID              int64
	TenantID         int64
	Role             Role
	UserGroupID      int64 // 0 = no group
	AllowedCampaigns []int64 // nil = '*' (all campaigns)
	AllCampaigns     bool    // true when AllowedCampaigns = '*'
	Perms            map[string]struct{} // integrator only
	JTI              string
	TotpVerified     bool
	Active           bool
}

// ScopeContext carries resource-level context evaluated by scope predicates.
type ScopeContext struct {
	TenantID     int64
	CampaignID   int64    // 0 = not set
	OwnerUserID  int64    // 0 = not set
	AssignedTo   []int64
	TargetUserID int64    // 0 = not set
	EntityID     int64    // for audit annotation
}
