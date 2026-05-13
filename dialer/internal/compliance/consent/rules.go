package consent

//go:generate go run ../../../../scripts/build-consent-rules/main.go --csv ../../../../db/seeds/consent_rules.csv --out rules_gen.go

// legalFloor returns the minimum consent Mode required by state law for a
// given 2-letter state code, using the generated stateRules map.
// States not in the map return ModeAllow (1-party federal floor).
func legalFloor(stateCode string) Mode {
	if r, ok := stateRules[stateCode]; ok {
		return r.MinimumMode
	}
	return ModeAllow
}

// IsStrictTwoParty returns true if the state is one of the 13 conservative
// two-party states in Phase 1. Used in property-based tests.
func IsStrictTwoParty(stateCode string) bool {
	r, ok := stateRules[stateCode]
	return ok && r.MinimumMode >= ModePromptMessage
}
