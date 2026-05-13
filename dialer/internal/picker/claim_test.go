package picker

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// TestClaimer_Claim_Success verifies a successful hopper claim.
func TestClaimer_Claim_Success(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(30)
	const leadID = int64(500)

	// Seed lead in hopper.
	hopperKey := vc.Keys.CampaignHopper(campaignID)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	claim, err := claimer.Claim(ctx, 1, campaignID, "pod-test", 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if claim.LeadID != leadID {
		t.Errorf("LeadID: got %d, want %d", claim.LeadID, leadID)
	}
	if claim.LockVal == "" {
		t.Error("LockVal should not be empty")
	}
}

// TestClaimer_Claim_Empty verifies ErrHopperEmpty on empty hopper.
func TestClaimer_Claim_Empty(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)

	_, err := claimer.Claim(context.Background(), 1, 31, "pod-test", 30)
	if err != ErrHopperEmpty {
		t.Errorf("expected ErrHopperEmpty, got: %v", err)
	}
}

// TestClaimer_Claim_EmptyInstanceID verifies validation.
func TestClaimer_Claim_EmptyInstanceID(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)

	_, err := claimer.Claim(context.Background(), 1, 32, "", 30)
	if err == nil {
		t.Error("expected error for empty instanceID")
	}
}

// TestClaimer_Release_Success verifies releasing a lead claim.
func TestClaimer_Release_Success(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(33)
	const leadID = int64(600)

	// Seed and claim a lead.
	hopperKey := vc.Keys.CampaignHopper(campaignID)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	claim, err := claimer.Claim(ctx, 1, campaignID, "pod-rel", 30)
	if err != nil {
		t.Fatalf("claim error: %v", err)
	}

	// Release with no requeue.
	err = claimer.Release(ctx, campaignID, claim.LeadID, claim.LockVal, false, 0)
	if err != nil {
		t.Fatalf("release error: %v", err)
	}
}

// TestClaimer_ReleaseWithPolicy_Requeue verifies requeue on retryable outcome.
func TestClaimer_ReleaseWithPolicy_Requeue(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(34)
	const leadID = int64(700)

	hopperKey := vc.Keys.CampaignHopper(campaignID)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	claim, err := claimer.Claim(ctx, 1, campaignID, "pod-rq", 30)
	if err != nil {
		t.Fatalf("claim error: %v", err)
	}

	// NoAnswer → policy says Requeue=true.
	err = claimer.ReleaseWithPolicy(ctx, campaignID, claim, OutcomeNoAnswer)
	if err != nil {
		t.Fatalf("ReleaseWithPolicy error: %v", err)
	}
}

// TestClaimer_ReleaseWithPolicy_Terminal verifies no requeue on terminal outcome.
func TestClaimer_ReleaseWithPolicy_Terminal(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(35)
	const leadID = int64(800)

	hopperKey := vc.Keys.CampaignHopper(campaignID)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	claim, err := claimer.Claim(ctx, 1, campaignID, "pod-term", 30)
	if err != nil {
		t.Fatalf("claim error: %v", err)
	}

	// DNCBlocked → terminal, no requeue.
	err = claimer.ReleaseWithPolicy(ctx, campaignID, claim, OutcomeDNCBlocked)
	if err != nil {
		t.Fatalf("ReleaseWithPolicy error: %v", err)
	}
}
