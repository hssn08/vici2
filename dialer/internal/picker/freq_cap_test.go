package picker

import (
	"context"
	"fmt"
	"testing"
)

// TestFreqCapIncrementer_IncrOnBridged verifies INCR on the freq cap key.
func TestFreqCapIncrementer_IncrOnBridged(t *testing.T) {
	vc, mr := newTestValkey(t)
	freq := NewFreqCapIncrementer(vc)
	ctx := context.Background()

	err := freq.IncrOnBridged(ctx, 1, 42, "+14155551234")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// freq cap uses vc.Cache (DB 1 in the same miniredis instance).
	key := fmt.Sprintf("t:%d:freq:%s:%d", 1, "+14155551234", 42)
	val, err := mr.DB(1).Get(key)
	if err != nil {
		t.Fatalf("expected freq cap key to exist: %s, err: %v", key, err)
	}
	if val != "1" {
		t.Errorf("expected freq cap=1, got %s", val)
	}
}

// TestFreqCapIncrementer_MultipleIncrements verifies counter accumulates.
func TestFreqCapIncrementer_MultipleIncrements(t *testing.T) {
	vc, mr := newTestValkey(t)
	freq := NewFreqCapIncrementer(vc)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if err := freq.IncrOnBridged(ctx, 1, 10, "+12125550100"); err != nil {
			t.Fatalf("IncrOnBridged error on iteration %d: %v", i, err)
		}
	}

	key := fmt.Sprintf("t:%d:freq:%s:%d", 1, "+12125550100", 10)
	val, _ := mr.DB(1).Get(key)
	if val != "3" {
		t.Errorf("expected freq cap=3 after 3 calls, got %s", val)
	}
}

// TestFreqCapIncrementer_DifferentCampaigns verifies keys are campaign-scoped.
func TestFreqCapIncrementer_DifferentCampaigns(t *testing.T) {
	vc, mr := newTestValkey(t)
	freq := NewFreqCapIncrementer(vc)
	ctx := context.Background()

	freq.IncrOnBridged(ctx, 1, 1, "+15555551111") //nolint:errcheck
	freq.IncrOnBridged(ctx, 1, 2, "+15555551111") //nolint:errcheck
	freq.IncrOnBridged(ctx, 1, 2, "+15555551111") //nolint:errcheck

	key1 := "t:1:freq:+15555551111:1"
	key2 := "t:1:freq:+15555551111:2"
	v1, _ := mr.DB(1).Get(key1)
	v2, _ := mr.DB(1).Get(key2)
	if v1 != "1" {
		t.Errorf("campaign 1 freq: expected 1, got %s", v1)
	}
	if v2 != "2" {
		t.Errorf("campaign 2 freq: expected 2, got %s", v2)
	}
}
