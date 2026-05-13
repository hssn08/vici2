package originate

// reservedNPAs is the set of NANP area codes that must never be used as
// local-presence caller-ID. Includes toll-free (8xx), premium-rate (900),
// fictitious (555), pay-per-call (976), and personal communication services.
var reservedNPAs = map[string]bool{
	// Toll-free
	"800": true, "833": true, "844": true, "855": true,
	"866": true, "877": true, "888": true,
	// Premium-rate
	"900": true,
	// Fictitious / test
	"555": true,
	// Pay-per-call (historical)
	"976": true,
	// Personal Communication Services (PCS) — non-geographic
	"500": true, "521": true, "522": true, "524": true,
	"533": true, "544": true, "566": true, "577": true, "588": true,
}

// isReservedNPA reports whether the given 3-digit NPA string is a reserved
// (non-geographic or toll) area code that must not be used as local-presence
// caller-ID. Returns false for any NPA that may be a valid geographic NPA.
func isReservedNPA(npa string) bool {
	return reservedNPAs[npa]
}

// extractNPA extracts the 3-digit area code (NPA) from an E.164 number.
// NANP E.164 format: +1NPANXXXXXX (total length ≥ 12).
// Returns "" for non-NANP numbers or invalid strings.
func extractNPA(e164 string) string {
	// Must start with +1 and be at least 12 chars (+1 + 10 digits)
	if len(e164) < 12 || e164[0] != '+' || e164[1] != '1' {
		return ""
	}
	// NPA is characters at positions 2, 3, 4 (after the +1 country code)
	npa := e164[2:5]
	// Validate: all digits
	for _, c := range npa {
		if c < '0' || c > '9' {
			return ""
		}
	}
	return npa
}
