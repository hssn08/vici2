package tz

import (
	"context"
	"strconv"
	"testing"
)

// benchResolver builds a resolver with a realistic-size mock data set.
func benchResolver(b *testing.B) *Resolver {
	b.Helper()
	r := &Resolver{campaignLRU: newCampaignCache(1000)}

	// Seed 170k phone_codes entries
	pm := make(phoneMap, 170_000)
	for npa := 200; npa < 999; npa++ {
		for nxx := 200; nxx < 999; nxx++ {
			key := uint32(npa*1000 + nxx)
			pm[key] = cacheEntry{IANA: "America/New_York"}
		}
	}
	pm[317555] = cacheEntry{IANA: "America/Indiana/Indianapolis"}
	r.phoneCodesCache.Store(&pm)
	om := make(phoneMap)
	r.overrideCache.Store(&om)

	zm := make(zipMap, 33_000)
	for z := 10000; z < 43000; z++ {
		zm[uint32(z)] = cacheEntry{IANA: "America/New_York"}
	}
	r.zipCodesCache.Store(&zm)

	npm := make(npaMap)
	npm["317"] = cacheEntry{IANA: "America/Indiana/Indianapolis"}
	npm["212"] = cacheEntry{IANA: "America/New_York"}
	r.npaOnlyCache.Store(&npm)

	// Pre-warm location caches
	warmLocations()
	for k := range pm {
		if k%10000 == 0 {
			npa := k / 1000
			_ = strconv.Itoa(int(npa))
		}
	}
	// Attach locations
	ny, _ := loadLocation("America/New_York")
	ind, _ := loadLocation("America/Indiana/Indianapolis")
	la, _ := loadLocation("America/Los_Angeles")

	for k, e := range pm {
		e.Loc = ny
		pm[k] = e
	}
	pm[317555] = cacheEntry{IANA: "America/Indiana/Indianapolis", Loc: ind}
	for k, e := range zm {
		e.Loc = la
		zm[k] = e
	}
	npm["317"] = cacheEntry{IANA: "America/Indiana/Indianapolis", Loc: ind}
	npm["212"] = cacheEntry{IANA: "America/New_York", Loc: ny}

	r.phoneCodesCache.Store(&pm)
	r.zipCodesCache.Store(&zm)
	r.npaOnlyCache.Store(&npm)

	return r
}

// BenchmarkResolveTier1 — KNOWN confidence (string compare + locCache hit).
// Pass criterion: < 500 ns/op.
func BenchmarkResolveTier1(b *testing.B) {
	r := benchResolver(b)
	ctx := context.Background()
	req := ResolveRequest{
		PhoneE164:     "+13175551212",
		KnownTimezone: "America/New_York",
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = r.Resolve(ctx, req)
	}
}

// BenchmarkResolveTier2_ZIP — ZIP lookup.
func BenchmarkResolveTier2_ZIP(b *testing.B) {
	r := benchResolver(b)
	ctx := context.Background()
	req := ResolveRequest{
		PhoneE164: "+13175551212",
		Zip:       "10001",
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = r.Resolve(ctx, req)
	}
}

// BenchmarkResolveTier3_NXX — NPA+NXX cache hit.
// Pass criterion: < 2 µs/op.
func BenchmarkResolveTier3_NXX(b *testing.B) {
	r := benchResolver(b)
	ctx := context.Background()
	req := ResolveRequest{
		PhoneE164: "+13175551212",
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = r.Resolve(ctx, req)
	}
}

// BenchmarkResolveTier5_State — STATE_DEFAULT confidence.
func BenchmarkResolveTier5_State(b *testing.B) {
	r := benchResolver(b)
	// Remove 555-555 from phone map so we fall to Tier 5
	pm := make(phoneMap)
	r.phoneCodesCache.Store(&pm)
	r.overrideCache.Store(&pm)
	nm := make(npaMap)
	r.npaOnlyCache.Store(&nm)
	zm := make(zipMap)
	r.zipCodesCache.Store(&zm)

	ctx := context.Background()
	req := ResolveRequest{
		PhoneE164: "+15555550000",
		State:     "CA",
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = r.Resolve(ctx, req)
	}
}

// BenchmarkResolveBatch1000 — 1000 varied leads.
// Pass criterion: < 1 ms total (i.e. < 1 ms/op at b.N=1).
func BenchmarkResolveBatch1000(b *testing.B) {
	r := benchResolver(b)
	ctx := context.Background()

	reqs := make([]ResolveRequest, 1000)
	for i := range reqs {
		reqs[i] = ResolveRequest{
			PhoneE164: "+1317555" + strconv.Itoa(1000+i),
		}
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = r.ResolveBatch(ctx, reqs)
	}
}
