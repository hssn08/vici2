// Benchmark for Can() hot path (M02 PLAN §12.3).
// Run: go test -bench=. -benchtime=1000000x ./dialer/internal/auth/rbac/
package rbac_test

import (
	"testing"

	"github.com/vici2/dialer/internal/auth/rbac"
)

func BenchmarkCanL1Hit(b *testing.B) {
	a := rbac.AuthContext{
		UID: 42, TenantID: 1, Role: rbac.RoleSupervisor,
		UserGroupID: 7, AllowedCampaigns: []int64{101}, AllCampaigns: false,
		JTI: "bench", Active: true,
	}
	s := rbac.ScopeContext{TenantID: 1, CampaignID: 101}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = rbac.Can(a, "call:listen", s)
	}
}

func BenchmarkCanTenantScope(b *testing.B) {
	a := rbac.AuthContext{
		UID: 42, TenantID: 1, Role: rbac.RoleAdmin,
		AllCampaigns: true, JTI: "bench", Active: true,
	}
	s := rbac.ScopeContext{TenantID: 1}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = rbac.Can(a, "lead:read", s)
	}
}
