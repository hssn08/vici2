// Can() — pure RBAC decision function (M02 PLAN §3.2).
// Go mirror of shared/auth/rbac/can.ts.
// Matrix constants live in matrix_gen.go (generated via `make gen-rbac`).
package rbac

// Can evaluates whether authCtx may perform verb within scopeCtx.
// It is pure — zero I/O. The caller must pre-hydrate AuthContext.
//
// Decision flow (fail-fast):
//  1. tenant_mismatch
//  2. inactive_user
//  3. totp stub (always passes in Phase 1)
//  4. integrator path (reads AuthContext.Perms)
//  5. matrix lookup
//  6. scope predicate
//  7. allow
func Can(auth AuthContext, verb string, scope ScopeContext) (d Decision) {
	defer func() {
		if r := recover(); r != nil {
			d = Decision{Allow: false, Reason: DenySystemError}
		}
	}()

	// 1. Tenant mismatch — most important guard
	if scope.TenantID != 0 && auth.TenantID != scope.TenantID {
		return Decision{Allow: false, Reason: DenyTenantMismatch}
	}

	// 2. Inactive user
	if !auth.Active {
		return Decision{Allow: false, Reason: DenyInactiveUser}
	}

	// 3. TOTP stub — F06 will wire; always pass in Phase 1

	// 4. Integrator path
	if auth.Role == RoleIntegrator {
		if _, ok := auth.Perms[verb]; ok {
			_, sensitive := SensitiveVerbs[verb]
			return Decision{Allow: true, Sensitive: sensitive}
		}
		return Decision{Allow: false, Reason: DenyIntegratorKeyLacksPerm}
	}

	// 5. Matrix lookup
	roleMatrix, ok := RoleVerbs[auth.Role]
	if !ok {
		return Decision{Allow: false, Reason: DenyNoGrant}
	}
	grant, ok := roleMatrix[verb]
	if !ok {
		return Decision{Allow: false, Reason: DenyNoGrant}
	}

	// 6. Scope predicate
	switch grant.Scope {
	case ScopeTenant:
		// already satisfied by step 1
	case ScopeGroup:
		if !PassGroupScope(auth, scope) {
			return Decision{Allow: false, Reason: DenyScopeGroup}
		}
	case ScopeOwn:
		if !PassOwnScope(auth, scope) {
			return Decision{Allow: false, Reason: DenyScopeOwn}
		}
	case ScopeSelf:
		if !PassSelfScope(auth, scope) {
			return Decision{Allow: false, Reason: DenyScopeSelf}
		}
	}

	// 7. Allow
	return Decision{Allow: true, Sensitive: grant.Sensitive}
}
