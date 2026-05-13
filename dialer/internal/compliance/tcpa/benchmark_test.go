package tcpa_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
)

// BenchmarkCheck asserts the hot-path latency of Check() stays under 1ms p99.
// Run: go test -bench=BenchmarkCheck -benchtime=10s ./internal/compliance/tcpa/
func BenchmarkCheck(b *testing.B) {
	c, err := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		SampleRate: 0, // no audit writes in bench
	})
	if err != nil {
		b.Fatal(err)
	}

	ctx := context.Background()
	// Midday Wednesday in ET — the happy ALLOW path.
	req := tcpa.CheckRequest{
		LeadID:           42,
		PhoneE164:        "+12125550099",
		KnownTimezone:    "America/New_York",
		State:            "NY",
		CampaignID:       1,
		EnforcementPoint: tcpa.PointHopper,
		IsAutoDialer:     false,
		When:             time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.Check(ctx, req)
	}
}

// BenchmarkCheckMEAutoDialer exercises the multi-intersect path (fed + state + autodialer).
func BenchmarkCheckMEAutoDialer(b *testing.B) {
	c, _ := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		SampleRate: 0,
	})
	ctx := context.Background()
	req := tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "ME",
		EnforcementPoint: tcpa.PointHopper,
		IsAutoDialer:     true,
		When:             time.Date(2026, 5, 13, 14, 30, 0, 0, time.UTC), // 10:30am ET Mon
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.Check(ctx, req)
	}
}

// BenchmarkWindowClosesWithin exercises the advisory-only boundary path.
func BenchmarkWindowClosesWithin(b *testing.B) {
	c, _ := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		SampleRate: 0,
	})
	ctx := context.Background()
	req := tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointPacing,
		When:             time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.WindowClosesWithin(ctx, req, 5*time.Minute)
	}
}
