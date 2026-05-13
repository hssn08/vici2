package tz

import (
	"log/slog"
	"sync"
	"time"
)

// locCache caches *time.Location pointers by IANA name.
// time.LoadLocation is ~10 µs cold (reads tzdata file); this makes it ~50 ns.
type locCache struct {
	mu sync.Map // string → *time.Location
}

var globalLocCache locCache

// loadLocation returns a *time.Location for the given IANA name.
// It is safe for concurrent use and lazy-populates on first call per name.
func loadLocation(iana string) (*time.Location, bool) {
	if v, ok := globalLocCache.mu.Load(iana); ok {
		return v.(*time.Location), true
	}
	loc, err := time.LoadLocation(iana)
	if err != nil {
		slog.Warn("tz: invalid IANA name", "iana", iana, "err", err)
		return nil, false
	}
	globalLocCache.mu.Store(iana, loc)
	return loc, true
}

// warmLocations pre-populates the cache for common US IANA names called at boot.
func warmLocations() {
	common := []string{
		"America/New_York",
		"America/Chicago",
		"America/Denver",
		"America/Los_Angeles",
		"America/Phoenix",
		"America/Anchorage",
		"Pacific/Honolulu",
		"America/Puerto_Rico",
		"Pacific/Guam",
		"Pacific/Pago_Pago",
		"America/Boise",
		"America/Indiana/Indianapolis",
		"America/Indiana/Knox",
		"America/Indiana/Marengo",
		"America/Indiana/Petersburg",
		"America/Indiana/Tell_City",
		"America/Indiana/Vevay",
		"America/Indiana/Vincennes",
		"America/Indiana/Winamac",
		"America/Kentucky/Louisville",
		"America/Kentucky/Monticello",
		"America/Indiana/Vincennes",
	}
	for _, iana := range common {
		loadLocation(iana)
	}
}
