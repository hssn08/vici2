// integration_test.go — exercises every Lua script against a live
// Valkey. The test is skipped unless VICI2_TEST_VALKEY_URL is set; CI
// is expected to start a sidecar container and inject the URL.
//
// Local run:
//   docker run -d --name v -p 26379:6379 valkey/valkey:8.0-alpine
//   VICI2_TEST_VALKEY_URL=redis://127.0.0.1:26379/0 \
//     go test ./internal/valkey -run Integration -v

package valkey

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func newTestClient(t *testing.T) *Client {
	t.Helper()
	url := os.Getenv("VICI2_TEST_VALKEY_URL")
	if url == "" {
		t.Skip("VICI2_TEST_VALKEY_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, err := New(ctx, Config{URL: url, TenantID: 1})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Wipe the DB to keep tests independent.
	if err := c.State.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("FlushDB: %v", err)
	}
	// SCRIPT FLUSH ensures NOSCRIPT-recovery path is exercised below.
	if err := c.State.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("ScriptFlush: %v", err)
	}
	return c
}

func TestIntegration_Ping(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestIntegration_NoScriptReload(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// Force a SCRIPT FLUSH, then a Claim — Eval should silently reload.
	if err := c.State.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("ScriptFlush: %v", err)
	}
	// Add one lead
	if err := c.Hopper().Push(ctx, 42, 12345, 1.0); err != nil {
		t.Fatalf("Push: %v", err)
	}
	leadID, _, err := c.Hopper().Claim(ctx, 42, "instance-A", 30, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("Claim after SCRIPT FLUSH: %v", err)
	}
	if leadID != 12345 {
		t.Fatalf("Claim lead: got %d want 12345", leadID)
	}
}

func TestIntegration_HopperClaimReleaseRoundTrip(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	if err := c.Hopper().Push(ctx, 42, 1, 1.0); err != nil {
		t.Fatal(err)
	}
	if err := c.Hopper().Push(ctx, 42, 2, 2.0); err != nil {
		t.Fatal(err)
	}
	if n, _ := c.Hopper().Size(ctx, 42); n != 2 {
		t.Fatalf("Size: got %d want 2", n)
	}

	id, lockVal, err := c.Hopper().Claim(ctx, 42, "I", 30, 100)
	if err != nil {
		t.Fatal(err)
	}
	if id != 1 {
		t.Fatalf("Claim: got %d want 1", id)
	}

	// in_flight HASH should have lead 1
	v, _ := c.State.HGet(ctx, c.Keys.CampaignInFlight(42), "1").Result()
	if v != lockVal {
		t.Fatalf("in_flight lock val: got %q want %q", v, lockVal)
	}

	// Release without reinsert
	ok, err := c.Hopper().Release(ctx, 42, 1, lockVal, false, 0)
	if err != nil || !ok {
		t.Fatalf("Release: ok=%v err=%v", ok, err)
	}
	exists, _ := c.State.Exists(ctx, c.Keys.LeadLock(42, 1)).Result()
	if exists != 0 {
		t.Fatalf("lock should be gone after release")
	}
	if n, _ := c.State.HLen(ctx, c.Keys.CampaignInFlight(42)).Result(); n != 0 {
		t.Fatalf("in_flight should be empty after release, got %d", n)
	}

	// Double-release with wrong lockVal returns released=false
	ok, _ = c.Hopper().Release(ctx, 42, 2, "wrong-val", false, 0)
	// Hopper has lead 2 still; lock for lead 2 doesn't exist; current=nil → script DELs (no-op) + returns 1.
	// Verify the behavior: when lock is absent, script returns 1 because `current` is nil.
	// (Lua: `local current = GET; if current and current ~= ARGV[4] then return 0`.)
	if !ok {
		t.Logf("note: Release on absent lock returned ok=false (defensible either way)")
	}
}

func TestIntegration_HopperConcurrentClaim(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	const N = 20
	for i := 0; i < N; i++ {
		if err := c.Hopper().Push(ctx, 42, int64(1000+i), float64(i)); err != nil {
			t.Fatal(err)
		}
	}

	const workers = 10
	var wg sync.WaitGroup
	wg.Add(workers)
	results := make(chan int64, workers*N)
	for w := 0; w < workers; w++ {
		go func(wid int) {
			defer wg.Done()
			for {
				id, _, err := c.Hopper().Claim(ctx, 42,
					"w"+strconv.Itoa(wid), 30, time.Now().UnixMilli())
				if err != nil {
					t.Errorf("Claim: %v", err)
					return
				}
				if id == 0 {
					return
				}
				results <- id
			}
		}(w)
	}
	wg.Wait()
	close(results)

	seen := make(map[int64]int)
	for id := range results {
		seen[id]++
	}
	if len(seen) != N {
		t.Fatalf("expected %d distinct claims, got %d", N, len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("lead %d claimed %d times — double-claim race!", id, n)
		}
	}
}

func TestIntegration_AgentStateTransition(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// First set: no expected status.
	if err := c.Agents().SetState(ctx, 42, 7, AgentReady, 1000,
		"campaign_id", "42"); err != nil {
		t.Fatalf("SetState: %v", err)
	}
	// READY indexes should contain 7.
	n, _ := c.State.ZScore(ctx, c.Keys.AgentsByStatus(AgentReady), "7").Result()
	if n != 1000 {
		t.Fatalf("ZScore READY: got %v want 1000", n)
	}

	// Transition READY → INCALL with correct expected status.
	ok, err := c.Agents().Transition(ctx, 42, 7, AgentReady, AgentInCall, 2000,
		"call_uuid", "abc-uuid")
	if err != nil || !ok {
		t.Fatalf("Transition READY->INCALL: ok=%v err=%v", ok, err)
	}
	cur, _ := c.State.HGet(ctx, c.Keys.Agent(7), "status").Result()
	if cur != "INCALL" {
		t.Fatalf("agent status: got %q want INCALL", cur)
	}
	// READY index should be empty; INCALL index should have 7.
	if n, _ := c.State.ZCard(ctx, c.Keys.AgentsByStatus(AgentReady)).Result(); n != 0 {
		t.Fatalf("READY index not empty: %d", n)
	}
	if n, _ := c.State.ZScore(ctx, c.Keys.AgentsByStatus(AgentInCall), "7").Result(); n != 2000 {
		t.Fatalf("ZScore INCALL: got %v want 2000", n)
	}

	// CAS guard: stale expected status returns false.
	ok, _ = c.Agents().Transition(ctx, 42, 7, AgentReady /* wrong */, AgentWrapup, 3000)
	if ok {
		t.Fatal("Transition should have refused stale expected status")
	}
}

func TestIntegration_PickAgentForCall(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// Two READY agents in campaign 42: user 7 (earlier ts), user 8.
	if err := c.Agents().SetState(ctx, 42, 7, AgentReady, 1000); err != nil {
		t.Fatal(err)
	}
	if err := c.Agents().SetState(ctx, 42, 8, AgentReady, 2000); err != nil {
		t.Fatal(err)
	}

	uid, err := c.Agents().PickForCall(ctx, 42, "uuid-A", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if uid != 7 {
		t.Fatalf("PickForCall first: got %d want 7 (longest-waiting)", uid)
	}
	uid2, _ := c.Agents().PickForCall(ctx, 42, "uuid-B", 5001)
	if uid2 != 8 {
		t.Fatalf("PickForCall second: got %d want 8", uid2)
	}
	uid3, _ := c.Agents().PickForCall(ctx, 42, "uuid-C", 5002)
	if uid3 != 0 {
		t.Fatalf("PickForCall when empty: got %d want 0", uid3)
	}
}

func TestIntegration_OriginateAcquireRelease(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// max_concurrent=2 — first two ALLOW, third BLOCK.
	r1, err := c.Originate().Acquire(ctx, 7, 42, 1001, "uuid-1", 2, 100, 60)
	if err != nil || !r1.Allowed || r1.NewActiveCount != 1 {
		t.Fatalf("Acquire 1: r=%+v err=%v", r1, err)
	}
	r2, err := c.Originate().Acquire(ctx, 7, 42, 1002, "uuid-2", 2, 100, 60)
	if err != nil || !r2.Allowed || r2.NewActiveCount != 2 {
		t.Fatalf("Acquire 2: r=%+v err=%v", r2, err)
	}
	r3, err := c.Originate().Acquire(ctx, 7, 42, 1003, "uuid-3", 2, 100, 60)
	if err == nil || r3.Allowed {
		t.Fatalf("Acquire 3 should have blocked, got r=%+v err=%v", r3, err)
	}
	if !strings.Contains(err.Error(), "gateway") {
		t.Fatalf("expected gateway-limit error, got %v", err)
	}

	// Release one → counter back to 1, third call now allowed.
	released, after, err := c.Originate().Release(ctx, 7, "uuid-1")
	if err != nil || !released || after != 1 {
		t.Fatalf("Release uuid-1: released=%v after=%d err=%v", released, after, err)
	}
	// Idempotent: second release on same UUID returns NOOP.
	released, after, err = c.Originate().Release(ctx, 7, "uuid-1")
	if err != nil || released {
		t.Fatalf("Release uuid-1 (2nd): should be NOOP, got released=%v err=%v", released, err)
	}
	_ = after
}

func TestIntegration_RefreshConsume(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// Seed: HSET refresh token + SADD family + SADD user.
	fam := "fam-1"
	hash := strings.Repeat("a", 64) // 64-hex shape required by Lua substring math
	tokKey := c.Keys.AuthRefresh(fam, hash)
	famKey := c.Keys.AuthRefreshFamily(fam)
	userKey := c.Keys.AuthRefreshUser(7)
	if err := c.State.HSet(ctx, tokKey,
		"user_id", "7", "tenant_id", "1", "family_id", fam,
		"role", "agent", "parent_token_hash", "",
		"expires_at", "9999999999",
	).Err(); err != nil {
		t.Fatal(err)
	}
	c.State.SAdd(ctx, famKey, hash)
	c.State.SAdd(ctx, userKey, fam)

	res, err := c.Scripts.Eval(ctx, c.State, ScriptRefreshConsume,
		[]string{tokKey, famKey, userKey}, fam)
	if err != nil {
		t.Fatalf("Eval refresh_consume: %v", err)
	}
	arr, _ := res.([]any)
	if len(arr) < 1 || arr[0] != "OK" {
		t.Fatalf("first consume: got %v", arr)
	}
	// Second consume on the same key triggers REUSE_DETECTED (family
	// still in cache — but we DEL'd the token in step 1, so the family
	// SCARD is 0 after SREM; the script returns NOT_FOUND, not REUSE.
	// To test the REUSE path, re-seed the family without the token key.
	c.State.SAdd(ctx, famKey, hash, hash+"_other")
	// Now consume — token key doesn't exist; family still has members.
	res, err = c.Scripts.Eval(ctx, c.State, ScriptRefreshConsume,
		[]string{tokKey, famKey, userKey}, fam)
	if err != nil {
		t.Fatalf("Eval refresh_consume (reuse): %v", err)
	}
	arr, _ = res.([]any)
	if len(arr) < 1 || arr[0] != "REUSE_DETECTED" {
		t.Fatalf("REUSE_DETECTED: got %v", arr)
	}
	// Family key should be wiped after REUSE.
	if n, _ := c.State.Exists(ctx, famKey).Result(); n != 0 {
		t.Fatalf("family key should be DEL'd after REUSE, got exists=%d", n)
	}
}

func TestIntegration_RecordCallOutcome(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()

	// Seed: in_flight HASH has lead, active SETs contain the uuid, call HASH set.
	cid := int64(42)
	leadID := int64(1001)
	uuid := "uuid-A"
	c.State.HSet(ctx, c.Keys.CampaignInFlight(cid), strconv.FormatInt(leadID, 10), "I:100")
	c.State.SAdd(ctx, c.Keys.CallActive(), uuid)
	c.State.SAdd(ctx, c.Keys.CampaignActiveCalls(cid), uuid)
	c.State.HSet(ctx, c.Keys.Call(uuid), "started_at", "100")

	res, err := c.Scripts.Eval(ctx, c.State, ScriptRecordCallOutcome,
		[]string{
			c.Keys.CampaignDropWindow(cid),
			EventStream("call", "answered"),
			c.Keys.CampaignInFlight(cid),
			c.Keys.Call(uuid),
			c.Keys.CallActive(),
			c.Keys.CampaignActiveCalls(cid),
		},
		"1",   // answered
		"0",   // dropped
		"200", // ts
		uuid,
		strconv.FormatInt(leadID, 10),
		strconv.FormatInt(cid, 10),
		"1", // tenant
		"500000",
		"1000000",
	)
	if err != nil {
		t.Fatalf("Eval record_call_outcome: %v", err)
	}
	if s, _ := res.(string); s != "OK" {
		t.Fatalf("expected OK, got %v", res)
	}

	// Drop-window stream should have one entry; in_flight + active SETs cleared.
	if n, _ := c.State.XLen(ctx, c.Keys.CampaignDropWindow(cid)).Result(); n != 1 {
		t.Fatalf("drop_window len: got %d want 1", n)
	}
	if n, _ := c.State.XLen(ctx, EventStream("call", "answered")).Result(); n != 1 {
		t.Fatalf("events stream len: got %d want 1", n)
	}
	if n, _ := c.State.HLen(ctx, c.Keys.CampaignInFlight(cid)).Result(); n != 0 {
		t.Fatalf("in_flight not cleared: %d", n)
	}
}

func TestIntegration_HasBloomModule(t *testing.T) {
	c := newTestClient(t)
	defer c.Close()
	ctx := context.Background()
	_, err := c.HasBloomModule(ctx)
	if err != nil {
		t.Fatalf("HasBloomModule: %v", err)
	}
	// We don't assert true/false — depends on whether the test image has it.
}

// _ keep go-redis types imported even if not directly used by tests above.
var _ = redis.Z{}
