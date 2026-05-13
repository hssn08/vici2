package pool

import (
	"math/rand"
	"testing"
	"time"
)

// TestPickHealthWeightedLRU_prefers_high_health verifies that a member with
// a much higher health score wins the majority of selections.
func TestPickHealthWeightedLRU_prefers_high_health(t *testing.T) {
	now := time.Now().Unix()
	members := []*PoolMember{
		{NPID: 1, DidID: 1, E164: "+11111111111", HealthScore: 10, LastUsedAt: now - 3600},
		{NPID: 2, DidID: 2, E164: "+12222222222", HealthScore: 90, LastUsedAt: now - 3600},
	}

	wins := [2]int{}
	const trials = 1000
	for i := 0; i < trials; i++ {
		// reset rand seed for determinism
		picked := pickHealthWeightedLRU(members)
		if picked == nil {
			t.Fatal("got nil from pickHealthWeightedLRU")
		}
		if picked.HealthScore == 90 {
			wins[1]++
		} else {
			wins[0]++
		}
	}
	// High-health should win at least 60% of the time
	if wins[1] < 600 {
		t.Errorf("high-health member won %d/%d times (want >= 600)", wins[1], trials)
	}
}

// TestPickHealthWeightedLRU_excludes_quarantined is covered by filterMembers;
// pickHealthWeightedLRU only receives eligible (non-quarantined) members.
// This test ensures single-member pool works.
func TestPickHealthWeightedLRU_single_member(t *testing.T) {
	m := &PoolMember{NPID: 1, DidID: 1, E164: "+11111111111", HealthScore: 50}
	got := pickHealthWeightedLRU([]*PoolMember{m})
	if got != m {
		t.Fatal("expected to get the single member back")
	}
}

// TestPickFromPool_empty_returns_error_via_pickLRU covers pickLRU empty case.
func TestPickLRU_returns_nil_on_empty(t *testing.T) {
	got := pickLRU([]*PoolMember{})
	if got != nil {
		t.Fatal("expected nil for empty slice")
	}
}

// TestPickLRU_selects_oldest verifies LRU picks the member with smallest LastUsedAt.
func TestPickLRU_selects_oldest(t *testing.T) {
	now := time.Now().Unix()
	members := []*PoolMember{
		{NPID: 1, DidID: 1, E164: "+11111111111", LastUsedAt: now - 100},
		{NPID: 2, DidID: 2, E164: "+12222222222", LastUsedAt: now - 9999},
		{NPID: 3, DidID: 3, E164: "+13333333333", LastUsedAt: now - 50},
	}
	got := pickLRU(members)
	if got.NPID != 2 {
		t.Errorf("expected NPID=2 (oldest), got NPID=%d", got.NPID)
	}
}

// TestPickRandom_no_panic_on_single_member verifies random pick doesn't panic.
func TestPickRandom_no_panic_on_single_member(t *testing.T) {
	m := &PoolMember{NPID: 1, DidID: 1, E164: "+11111111111"}
	got := pickRandom([]*PoolMember{m})
	if got != m {
		t.Fatal("expected to get the single member back")
	}
}

// TestPickRandom_nil_on_empty verifies random pick returns nil for empty slice.
func TestPickRandom_nil_on_empty(t *testing.T) {
	got := pickRandom([]*PoolMember{})
	if got != nil {
		t.Fatal("expected nil for empty slice")
	}
}

// TestPickHealthWeightedLRU_nil_on_empty verifies nil return for empty.
func TestPickHealthWeightedLRU_nil_on_empty(t *testing.T) {
	got := pickHealthWeightedLRU([]*PoolMember{})
	if got != nil {
		t.Fatal("expected nil for empty slice")
	}
}

// TestPickHealthWeightedLRU_never_used_members handles LastUsedAt == 0.
func TestPickHealthWeightedLRU_never_used_members(t *testing.T) {
	members := []*PoolMember{
		{NPID: 1, DidID: 1, E164: "+11111111111", HealthScore: 80, LastUsedAt: 0},
		{NPID: 2, DidID: 2, E164: "+12222222222", HealthScore: 80, LastUsedAt: 0},
	}
	// Should not panic
	rand.Seed(42) //nolint:gosec
	got := pickHealthWeightedLRU(members)
	if got == nil {
		t.Fatal("expected a member")
	}
}
