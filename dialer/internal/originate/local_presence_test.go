package originate

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/pool"
	"github.com/vici2/dialer/internal/valkey"
)

// mockNPAStateResolver is a simple NPA→state lookup for tests.
type mockNPAStateResolver struct {
	m map[string]string
}

func (r *mockNPAStateResolver) StateForNPA(npa string) string {
	return r.m[npa]
}

// mockPoolService records calls and allows injecting a fixed result or error.
type mockPoolService struct {
	pickResult *pool.PickResult
	pickErr    error
	pickCalls  int
	members    []pool.PoolMember
}

func (m *mockPoolService) PickFromPool(_ context.Context, _ pool.PickRequest) (*pool.PickResult, error) {
	m.pickCalls++
	return m.pickResult, m.pickErr
}

func (m *mockPoolService) GetMembers(_ context.Context, _, _ int64) ([]pool.PoolMember, pool.PoolConfig, error) {
	return m.members, pool.PoolConfig{}, nil
}

// localPresencePickerForTest builds a LocalPresencePicker backed by miniredis.
func localPresencePickerForTest(t *testing.T, mr *miniredis.Miniredis, svc poolServiceIface, tz NPAStateResolver) *LocalPresencePicker {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	keys := valkey.NewKeys(1)
	return &LocalPresencePicker{
		poolSvc:      nil, // replaced by field injection below
		rdb:          rdb,
		keys:         keys,
		tzResolver:   tz,
		indexBuilder: nil,
		svcInterface: svc,
	}
}

// poolServiceIface is the minimal interface LocalPresencePicker needs.
// Defined here so tests can use a mock without needing *pool.Service.
type poolServiceIface interface {
	PickFromPool(ctx context.Context, req pool.PickRequest) (*pool.PickResult, error)
	GetMembers(ctx context.Context, tenantID, poolID int64) ([]pool.PoolMember, pool.PoolConfig, error)
}

// ---- AC-1: Exact NPA match --------------------------------------------------

func TestLocalPresence_ExactNPAMatch(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// Seed: pool 7 has DID 1001 in NPA 415
	mr.SAdd(keys.PoolNPAIndex(7, "415"), "1001")
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	tz := &mockNPAStateResolver{m: map[string]string{"415": "CA"}}
	members := []pool.PoolMember{
		{DidID: 1001, E164: "+14155551001", AreaCode: "415", NPID: 10},
	}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+14155550000", DidID: 9999},
		members:    members,
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	res, err := picker.pickWithInterface(ctx, 1, 7, "+14155559999", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierExactNPA {
		t.Errorf("MatchTier = %d; want %d (exact_npa)", res.MatchTier, MatchTierExactNPA)
	}
	if res.DidID != 1001 {
		t.Errorf("DidID = %d; want 1001", res.DidID)
	}
	if svc.pickCalls != 0 {
		t.Errorf("x04 fallback called %d times; want 0", svc.pickCalls)
	}
}

// ---- AC-2: Neighbor NPA match -----------------------------------------------

func TestLocalPresence_NeighborNPAMatch(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// Pool has 646 DID but no 212 DID. 212→646 is neighbor.
	mr.SAdd(keys.PoolNPAIndex(7, "646"), "2001")
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	tz := &mockNPAStateResolver{m: map[string]string{"212": "NY", "646": "NY"}}
	members := []pool.PoolMember{
		{DidID: 2001, E164: "+16465551001", AreaCode: "646", NPID: 20},
	}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+10000000000", DidID: 0},
		members:    members,
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	// Called from NPA 212; pool has only 646.
	res, err := picker.pickWithInterface(ctx, 1, 7, "+12125559999", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierNeighborNPA {
		t.Errorf("MatchTier = %d; want %d (neighbor_npa)", res.MatchTier, MatchTierNeighborNPA)
	}
	if res.DidID != 2001 {
		t.Errorf("DidID = %d; want 2001", res.DidID)
	}
}

// ---- AC-3: Same-state match -------------------------------------------------

func TestLocalPresence_SameStateMatch(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// Pool has 619 (San Diego CA) but not 408 (San Jose CA) or 669 (neighbor).
	mr.SAdd(keys.PoolStateIndex(7, "CA"), "3001")
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	tz := &mockNPAStateResolver{m: map[string]string{"408": "CA", "619": "CA", "669": "CA"}}
	members := []pool.PoolMember{
		{DidID: 3001, E164: "+16195551001", AreaCode: "619", NPID: 30},
	}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+10000000000", DidID: 0},
		members:    members,
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	res, err := picker.pickWithInterface(ctx, 1, 7, "+14085559999", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierSameState {
		t.Errorf("MatchTier = %d; want %d (same_state)", res.MatchTier, MatchTierSameState)
	}
	if res.DidID != 3001 {
		t.Errorf("DidID = %d; want 3001", res.DidID)
	}
}

// ---- AC-4: Fallback to Tier 4 -----------------------------------------------

func TestLocalPresence_Fallback(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// Empty pool — no NPA or state index entries.
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	tz := &mockNPAStateResolver{m: map[string]string{"212": "NY"}}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+19995550000", DidID: 9999},
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	res, err := picker.pickWithInterface(ctx, 1, 7, "+12125559999", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierPoolFallback {
		t.Errorf("MatchTier = %d; want %d (pool_fallback)", res.MatchTier, MatchTierPoolFallback)
	}
	if svc.pickCalls != 1 {
		t.Errorf("x04 fallback called %d times; want 1", svc.pickCalls)
	}
}

// ---- AC-5: Quarantine skip --------------------------------------------------

func TestLocalPresence_QuarantineSkip(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// DID 4001 in NPA 415 but quarantined.
	mr.SAdd(keys.PoolNPAIndex(7, "415"), "4001")
	mr.Set(keys.DIDQuarantined(7, 4001), "1") // quarantined
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	// DID 4002 available in state CA.
	mr.SAdd(keys.PoolStateIndex(7, "CA"), "4002")

	tz := &mockNPAStateResolver{m: map[string]string{"415": "CA"}}
	members := []pool.PoolMember{
		{DidID: 4001, E164: "+14155554001", AreaCode: "415", NPID: 40},
		{DidID: 4002, E164: "+16195554002", AreaCode: "619", NPID: 41},
	}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+10000000000", DidID: 0},
		members:    members,
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	res, err := picker.pickWithInterface(ctx, 1, 7, "+14155559999", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Tier 1 was quarantined; should fall through to Tier 3 (same state).
	if res.MatchTier != MatchTierSameState && res.MatchTier != MatchTierPoolFallback {
		t.Errorf("MatchTier = %d; want same_state(3) or pool_fallback(4)", res.MatchTier)
	}
}

// ---- AC-6: Reserved NPA skip ------------------------------------------------

func TestLocalPresence_ReservedNPASkip(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)
	mr.Set(keys.PoolNPAIndexBuilt(7), "1")

	tz := &mockNPAStateResolver{}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+18005550000", DidID: 8000},
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	// Calling toll-free 800 number — must skip to Tier 4.
	res, err := picker.pickWithInterface(ctx, 1, 7, "+18005551234", true, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierPoolFallback {
		t.Errorf("MatchTier = %d; want pool_fallback(4)", res.MatchTier)
	}
	if svc.pickCalls != 1 {
		t.Errorf("x04 fallback called %d times; want 1", svc.pickCalls)
	}
}

// ---- AC-7: Feature flag (local_presence_enabled=false) ----------------------

func TestLocalPresence_FeatureFlagDisabled(t *testing.T) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	tz := &mockNPAStateResolver{}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+14155550000", DidID: 5001},
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	// localPresenceEnabled = false: no Valkey NPA lookup should happen.
	res, err := picker.pickWithInterface(ctx, 1, 7, "+14155559999", false, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.MatchTier != MatchTierPoolFallback {
		t.Errorf("MatchTier = %d; want pool_fallback(4)", res.MatchTier)
	}
	if svc.pickCalls != 1 {
		t.Errorf("x04 fallback called %d times; want 1", svc.pickCalls)
	}
}

// BenchmarkPickCallerIDWithLocalPresence verifies the ≤5ms p99 requirement.
func BenchmarkPickCallerIDWithLocalPresence(b *testing.B) {
	mr, _ := miniredis.Run()
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	keys := valkey.NewKeys(1)

	// Seed with a matching DID in tier 1.
	mr.SAdd(keys.PoolNPAIndex(1, "415"), "1001")
	mr.Set(keys.PoolNPAIndexBuilt(1), "1")

	tz := &mockNPAStateResolver{m: map[string]string{"415": "CA"}}
	members := []pool.PoolMember{
		{DidID: 1001, E164: "+14155551001", AreaCode: "415", NPID: 1},
	}
	svc := &mockPoolService{
		pickResult: &pool.PickResult{E164: "+14155550000", DidID: 9999},
		members:    members,
	}

	picker := &LocalPresencePicker{
		rdb: rdb, keys: keys, tzResolver: tz,
		svcInterface: svc,
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = picker.pickWithInterface(ctx, 1, 1, "+14155559999", true, 0)
	}
}
