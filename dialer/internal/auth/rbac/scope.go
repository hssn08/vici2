// Scope predicate functions — Go mirror of shared/auth/rbac/scope.ts (M02 PLAN §3.3).
package rbac

// PassGroupScope returns true when campaignID is in auth.AllowedCampaigns
// (or AllCampaigns == true). Zero campaignID is treated as not-set → deny.
func PassGroupScope(auth AuthContext, scope ScopeContext) bool {
	if scope.CampaignID == 0 {
		return false
	}
	if auth.AllCampaigns {
		return true
	}
	for _, id := range auth.AllowedCampaigns {
		if id == scope.CampaignID {
			return true
		}
	}
	return false
}

// PassOwnScope returns true when ownerUserID matches auth.UID
// OR auth.UID appears in the assignedTo list.
func PassOwnScope(auth AuthContext, scope ScopeContext) bool {
	if scope.OwnerUserID != 0 && scope.OwnerUserID == auth.UID {
		return true
	}
	for _, id := range scope.AssignedTo {
		if id == auth.UID {
			return true
		}
	}
	return false
}

// PassSelfScope returns true when targetUserID equals auth.UID.
// Zero targetUserID → deny.
func PassSelfScope(auth AuthContext, scope ScopeContext) bool {
	return scope.TargetUserID != 0 && scope.TargetUserID == auth.UID
}
