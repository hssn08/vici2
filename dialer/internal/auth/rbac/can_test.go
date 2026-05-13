// Go unit tests for Can() (M02 PLAN §14.1).
package rbac_test

import (
	"testing"

	"github.com/vici2/dialer/internal/auth/rbac"
)

func auth(role rbac.Role) rbac.AuthContext {
	return rbac.AuthContext{
		UID:              42,
		TenantID:         1,
		Role:             role,
		UserGroupID:      7,
		AllowedCampaigns: []int64{101},
		AllCampaigns:     false,
		JTI:              "jti",
		TotpVerified:     false,
		Active:           true,
	}
}

func scope(tenantID int64) rbac.ScopeContext {
	return rbac.ScopeContext{TenantID: tenantID}
}

func TestTenantMismatch(t *testing.T) {
	a := auth(rbac.RoleAdmin)
	a.AllCampaigns = true
	d := rbac.Can(a, "lead:read", rbac.ScopeContext{TenantID: 2})
	if d.Allow || d.Reason != rbac.DenyTenantMismatch {
		t.Errorf("expected tenant_mismatch, got %+v", d)
	}
}

func TestInactiveUser(t *testing.T) {
	a := auth(rbac.RoleAdmin)
	a.Active = false
	d := rbac.Can(a, "lead:read", scope(1))
	if d.Allow || d.Reason != rbac.DenyInactiveUser {
		t.Errorf("expected inactive_user, got %+v", d)
	}
}

func TestNoGrant(t *testing.T) {
	a := auth(rbac.RoleAgent)
	d := rbac.Can(a, "lead:import", scope(1))
	if d.Allow || d.Reason != rbac.DenyNoGrant {
		t.Errorf("expected no_grant, got %+v", d)
	}
}

func TestSuperAdminDncBypass(t *testing.T) {
	a := auth(rbac.RoleSuperAdmin)
	a.AllCampaigns = true
	d := rbac.Can(a, "dnc:bypass", scope(1))
	if !d.Allow || !d.Sensitive {
		t.Errorf("expected allow+sensitive, got %+v", d)
	}
}

func TestAdminDncBypassDenied(t *testing.T) {
	a := auth(rbac.RoleAdmin)
	a.AllCampaigns = true
	d := rbac.Can(a, "dnc:bypass", scope(1))
	if d.Allow || d.Reason != rbac.DenyNoGrant {
		t.Errorf("expected no_grant for admin dnc:bypass, got %+v", d)
	}
}

func TestScopeGroupAllowed(t *testing.T) {
	a := auth(rbac.RoleSupervisor)
	d := rbac.Can(a, "call:listen", rbac.ScopeContext{TenantID: 1, CampaignID: 101})
	if !d.Allow || !d.Sensitive {
		t.Errorf("expected allow+sensitive for supervisor call:listen on allowed campaign, got %+v", d)
	}
}

func TestScopeGroupDenied(t *testing.T) {
	a := auth(rbac.RoleSupervisor)
	d := rbac.Can(a, "call:listen", rbac.ScopeContext{TenantID: 1, CampaignID: 999})
	if d.Allow || d.Reason != rbac.DenyScopeGroup {
		t.Errorf("expected scope_group, got %+v", d)
	}
}

func TestScopeOwnAllowed(t *testing.T) {
	a := auth(rbac.RoleAgent)
	d := rbac.Can(a, "lead:read", rbac.ScopeContext{TenantID: 1, OwnerUserID: 42})
	if !d.Allow {
		t.Errorf("expected allow for agent lead:read own, got %+v", d)
	}
}

func TestScopeOwnDenied(t *testing.T) {
	a := auth(rbac.RoleAgent)
	d := rbac.Can(a, "lead:read", rbac.ScopeContext{TenantID: 1, OwnerUserID: 99})
	if d.Allow || d.Reason != rbac.DenyScopeOwn {
		t.Errorf("expected scope_own, got %+v", d)
	}
}

func TestScopeSelfAllowed(t *testing.T) {
	a := auth(rbac.RoleAgent)
	d := rbac.Can(a, "user:read", rbac.ScopeContext{TenantID: 1, TargetUserID: 42})
	if !d.Allow {
		t.Errorf("expected allow for agent user:read self, got %+v", d)
	}
}

func TestScopeSelfDenied(t *testing.T) {
	a := auth(rbac.RoleAgent)
	d := rbac.Can(a, "user:read", rbac.ScopeContext{TenantID: 1, TargetUserID: 99})
	if d.Allow || d.Reason != rbac.DenyScopeSelf {
		t.Errorf("expected scope_self, got %+v", d)
	}
}

func TestIntegratorAllowed(t *testing.T) {
	a := auth(rbac.RoleIntegrator)
	a.Perms = map[string]struct{}{"lead:read": {}}
	d := rbac.Can(a, "lead:read", scope(1))
	if !d.Allow || d.Sensitive {
		t.Errorf("expected allow+!sensitive for integrator lead:read, got %+v", d)
	}
}

func TestIntegratorDenied(t *testing.T) {
	a := auth(rbac.RoleIntegrator)
	a.Perms = map[string]struct{}{"lead:read": {}}
	d := rbac.Can(a, "lead:edit", scope(1))
	if d.Allow || d.Reason != rbac.DenyIntegratorKeyLacksPerm {
		t.Errorf("expected integrator_key_lacks_perm, got %+v", d)
	}
}

func TestViewerReadOnly(t *testing.T) {
	a := auth(rbac.RoleViewer)
	a.AllCampaigns = true
	// viewer can lead:read
	d := rbac.Can(a, "lead:read", scope(1))
	if !d.Allow {
		t.Errorf("expected viewer lead:read allow, got %+v", d)
	}
	// viewer cannot lead:edit
	d2 := rbac.Can(a, "lead:edit", scope(1))
	if d2.Allow || d2.Reason != rbac.DenyNoGrant {
		t.Errorf("expected no_grant for viewer lead:edit, got %+v", d2)
	}
}

func TestAllCampaignsPassesGroupScope(t *testing.T) {
	a := auth(rbac.RoleAdmin)
	a.AllCampaigns = true
	d := rbac.Can(a, "call:listen", rbac.ScopeContext{TenantID: 1, CampaignID: 999})
	if !d.Allow {
		t.Errorf("expected admin with AllCampaigns to pass group scope, got %+v", d)
	}
}
