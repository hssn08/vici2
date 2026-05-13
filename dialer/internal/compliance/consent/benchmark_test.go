package consent_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/consent"
)

// BenchmarkCheckConsent asserts the hot-path latency stays under 200µs p99.
// Run: go test -bench=BenchmarkCheckConsent -benchtime=10s ./internal/compliance/consent/
func BenchmarkCheckConsent(b *testing.B) {
	c, err := consent.New(consent.CheckerOpts{
		Audit: consent.NoopSinkForTest(),
		NowFn: func() time.Time { return time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		b.Fatal(err)
	}

	ctx := context.Background()
	// TX→TX: the happy ALLOW path (pure map miss + 4 comparisons).
	req := consent.CheckRequest{
		TenantID:                 1,
		CampaignID:               1,
		LeadID:                   42,
		LeadState:                "TX",
		CallerState:              "TX",
		LeadIsBusiness:           false,
		CampaignRecordingPurpose: consent.PurposeGeneral,
		CampaignRecordingPolicy:  consent.PolicyAlways,
		TenantMinimumMode:        consent.ModeAllow,
		When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.CheckConsent(ctx, req)
	}
}

// BenchmarkCheckConsentCA exercises the 2-party state hit path (CA→CA).
func BenchmarkCheckConsentCA(b *testing.B) {
	c, _ := consent.New(consent.CheckerOpts{
		Audit: consent.NoopSinkForTest(),
	})
	ctx := context.Background()
	req := consent.CheckRequest{
		TenantID:                 1,
		CampaignID:               1,
		LeadID:                   42,
		LeadState:                "CA",
		CallerState:              "CA",
		CampaignRecordingPolicy:  consent.PolicyAlways,
		TenantMinimumMode:        consent.ModePromptMessage,
		ConsentMsgAudioPath:      "/var/lib/freeswitch/sounds/consent/default/en-US/vici2_consent_msg.wav",
		When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.CheckConsent(ctx, req)
	}
}

// BenchmarkCheckConsentPAB2B exercises the PA B2B carveout path.
func BenchmarkCheckConsentPAB2B(b *testing.B) {
	c, _ := consent.New(consent.CheckerOpts{
		Audit: consent.NoopSinkForTest(),
	})
	ctx := context.Background()
	req := consent.CheckRequest{
		TenantID:                 1,
		CampaignID:               1,
		LeadID:                   42,
		LeadState:                "PA",
		CallerState:              "TX",
		LeadIsBusiness:           true,
		CampaignRecordingPurpose: consent.PurposeTraining,
		CampaignRecordingPolicy:  consent.PolicyAlways,
		TenantMinimumMode:        consent.ModeAllow,
		When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = c.CheckConsent(ctx, req)
	}
}
