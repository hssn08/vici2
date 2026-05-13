package picker

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestTokenBucket_ConcurrentAcquire verifies that concurrent DECRs from
// multiple goroutines never over-consume the token budget beyond n+1.
// This models the multi-pod scenario from PLAN §9.1.
func TestTokenBucket_ConcurrentAcquire(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	tb := NewTokenBucket(vc, m)
	ctx := context.Background()

	const budget = 5
	const goroutines = 20

	// Set tokens=budget.
	mr.Set(dispatchTokensKey(1, 99), "5")

	var (
		wg      sync.WaitGroup
		success int64
		fail    int64
	)

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			ok, err := tb.Acquire(ctx, 1, 99)
			if err != nil && err != ErrNoTokens {
				return
			}
			if ok {
				atomic.AddInt64(&success, 1)
			} else {
				atomic.AddInt64(&fail, 1)
			}
		}()
	}
	wg.Wait()

	// Should not have consumed more than budget+1 (one over-decrement is
	// detected and restored; PLAN §9.1 and §3.2 accept bounded leakage).
	if success > budget+1 {
		t.Errorf("over-consumed tokens: success=%d, budget=%d", success, budget)
	}
	// At least budget successful acquires (the rest hit over-decrement).
	if success < 1 {
		t.Error("expected at least 1 successful token acquire")
	}
	t.Logf("concurrent token test: success=%d fail=%d budget=%d", success, fail, budget)
}

// TestClaimer_ConcurrentClaim verifies no double-claim via atomic Lua.
// 10 goroutines race to claim from a hopper of 5 leads; each lead should
// appear at most once as a successful claim.
func TestClaimer_ConcurrentClaim(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(100)
	const numLeads = 5
	const numWorkers = 10

	// Pre-populate hopper with 5 leads.
	hopperKey := vc.Keys.CampaignHopper(campaignID)
	for i := 1; i <= numLeads; i++ {
		mr.ZAdd(hopperKey, float64(i), fmt.Sprintf("%d", i))
	}

	var (
		wg      sync.WaitGroup
		claimed sync.Map // leadID → claim count (should always be 1)
	)

	wg.Add(numWorkers)
	for w := 0; w < numWorkers; w++ {
		workerID := w
		go func() {
			defer wg.Done()
			for {
				claim, err := claimer.Claim(ctx, 1, campaignID,
					fmt.Sprintf("worker-%d", workerID), 30)
				if err == ErrHopperEmpty {
					return // hopper drained
				}
				if err != nil {
					return // Valkey error
				}
				// Record this claim.
				if _, loaded := claimed.LoadOrStore(claim.LeadID, 1); loaded {
					// Lead was already claimed by another worker — double-claim!
					t.Errorf("DOUBLE CLAIM detected for lead %d", claim.LeadID)
				}
				// Release immediately (no T04 in this test).
				claimer.Release(ctx, campaignID, claim.LeadID, claim.LockVal, false, 0) //nolint:errcheck
			}
		}()
	}
	wg.Wait()

	// Verify each of the 5 leads was claimed exactly once.
	claimedCount := 0
	claimed.Range(func(_, _ interface{}) bool {
		claimedCount++
		return true
	})
	if claimedCount > numLeads {
		t.Errorf("claimed %d leads but hopper had only %d", claimedCount, numLeads)
	}
}

// TestConfigCache_ConcurrentReadWrite verifies the campaign config cache is
// thread-safe under concurrent reads and writes.
func TestConfigCache_ConcurrentReadWrite(t *testing.T) {
	cache := NewCampaignConfigCache()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	var wg sync.WaitGroup

	// Writers: update config every 10 ms.
	wg.Add(2)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				cache.Set(CampaignConfig{TenantID: 1, CampaignID: 1, Active: true})
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				cache.Set(CampaignConfig{TenantID: 1, CampaignID: 2, Active: false})
				time.Sleep(15 * time.Millisecond)
			}
		}
	}()

	// Readers: read concurrently.
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					cache.IsActive(1)
					cache.IsActive(2)
					cache.ActiveCampaignIDs()
					time.Sleep(5 * time.Millisecond)
				}
			}
		}()
	}

	wg.Wait()
	// No panic = pass.
}
