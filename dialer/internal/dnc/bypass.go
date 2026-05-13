package dnc

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"

	"github.com/redis/go-redis/v9"
)

//go:embed lua/redeem_dnc_bypass.v1.lua
var redeemBypassLua string

// RedeemResult is the outcome of a bypass token redemption.
type RedeemResult string

const (
	RedeemOK       RedeemResult = "ok"
	RedeemMismatch RedeemResult = "mismatch"
	RedeemExpired  RedeemResult = "expired"
)

func bypassKey(tenantID int64, tokenHash string) string {
	return fmt.Sprintf("t:%d:dnc:bypass:%s", tenantID, tokenHash)
}

func hashHex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// RedeemBypass atomically redeems a single-use DNC bypass token (PLAN §6.6 + §7.2).
// tokenHash must be SHA-256(hex) of the raw token string.
func RedeemBypass(
	ctx context.Context,
	rdb redis.UniversalClient,
	tenantID int64,
	tokenHash string,
	phone string,
	source Source,
	userID int64,
	justification string,
) (RedeemResult, error) {
	key := bypassKey(tenantID, tokenHash)
	justHash := hashHex(justification)
	expected := fmt.Sprintf("%s|%s|%d|%s", phone, string(source), userID, justHash)

	res, err := rdb.Eval(ctx, redeemBypassLua, []string{key}, expected).Text()
	if err == redis.Nil {
		return RedeemExpired, nil
	}
	if err != nil {
		return RedeemExpired, err
	}
	switch res {
	case "OK":
		return RedeemOK, nil
	case "MISMATCH":
		return RedeemMismatch, nil
	default:
		return RedeemExpired, nil
	}
}
