package dnc

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupBypassRedis(t *testing.T) (*miniredis.Miniredis, redis.UniversalClient) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return mr, rdb
}

func TestRedeemBypass_ExpiredMissing(t *testing.T) {
	_, rdb := setupBypassRedis(t)
	// Key never set → expired
	res, err := RedeemBypass(
		context.Background(), rdb,
		1, "nonexistent-hash",
		"+14155551212", SourceFederal, 99, "some justification",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != RedeemExpired {
		t.Fatalf("expected RedeemExpired, got %v", res)
	}
}

func TestRedeemBypass_SingleUse(t *testing.T) {
	_, rdb := setupBypassRedis(t)

	tenantID := int64(1)
	phone := "+14155551212"
	source := SourceInternal
	userID := int64(7)
	justification := "returning inbound call"

	justHash := hashHex(justification)
	payload := phone + "|" + string(source) + "|7|" + justHash
	tokenHash := "abc123"
	key := bypassKey(tenantID, tokenHash)

	// Manually set the key as if mintBypassToken had run
	if err := rdb.Set(context.Background(), key, payload, 60*1e9).Err(); err != nil {
		t.Fatalf("set: %v", err)
	}

	// First redeem → OK
	res, err := RedeemBypass(context.Background(), rdb, tenantID, tokenHash, phone, source, userID, justification)
	if err != nil {
		t.Fatalf("redeem error: %v", err)
	}
	if res != RedeemOK {
		t.Fatalf("expected RedeemOK, got %v", res)
	}

	// Second redeem → expired (key was GETDEL'd)
	res2, err := RedeemBypass(context.Background(), rdb, tenantID, tokenHash, phone, source, userID, justification)
	if err != nil {
		t.Fatalf("second redeem error: %v", err)
	}
	if res2 != RedeemExpired {
		t.Fatalf("expected RedeemExpired on second attempt, got %v", res2)
	}
}

func TestRedeemBypass_Mismatch(t *testing.T) {
	_, rdb := setupBypassRedis(t)

	tenantID := int64(1)
	tokenHash := "mismatch-hash"
	key := bypassKey(tenantID, tokenHash)

	// Store a different payload
	if err := rdb.Set(context.Background(), key, "wrong|payload", 60).Err(); err != nil {
		t.Fatalf("set: %v", err)
	}

	res, err := RedeemBypass(
		context.Background(), rdb, tenantID, tokenHash,
		"+14155551212", SourceFederal, 99, "justification",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != RedeemMismatch {
		t.Fatalf("expected RedeemMismatch, got %v", res)
	}
}
