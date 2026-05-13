package tz

import "time"

// NumberType classifies a phone number's line type.
// Reported in ResolveResult; C01 may use MOBILE flag for confidence adjustments.
type NumberType int

const (
	NumberTypeUnknown       NumberType = iota
	NumberTypeFixedLine                // 1
	NumberTypeMobile                   // 2
	NumberTypeFixedOrMobile            // 3
	NumberTypeTollFree                 // 4
	NumberTypePremiumRate              // 5
	NumberTypeVoip                     // 6
)

// ResolveRequest is the input to Resolver.Resolve / ResolveBatch.
type ResolveRequest struct {
	LeadID        int64  // optional; 0 = phone-only lookup
	PhoneE164     string // required; "+13175551212"
	KnownTimezone string // optional; IANA string from lead.known_timezone
	Zip           string // optional; lead.postal_code (5-digit US)
	State         string // optional; 2-char US state code
	CampaignID    string // optional; for Tier 6 default lookup
}

// ResolveResult is the output of Resolver.Resolve.
type ResolveResult struct {
	IANA       string         // "America/New_York"; "" if NONE
	Location   *time.Location // pre-loaded; nil if NONE
	Confidence Confidence
	Source     string     // "lead.known_timezone" | "zip:30024" | "nxx:317-555" | ...
	NPA        string
	NXX        string
	NumberType NumberType // informational; MOBILE flag passed to C01
}

// cacheEntry is the in-memory representation of a phone_codes / zip_codes row.
type cacheEntry struct {
	IANA string
	Loc  *time.Location
}
