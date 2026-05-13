// originate.go — typed wrapper around T04's 5-gate originate audit Lua.
// PLAN F04 §11; T04 PLAN §11.2.

package valkey

import (
	"context"
	"errors"
	"fmt"
	"strconv"
)

// OriginateOps groups gateway-cap + in-flight atomic operations.
type OriginateOps struct{ c *Client }

// Originate returns originate-related typed ops bound to this client.
func (c *Client) Originate() *OriginateOps { return &OriginateOps{c: c} }

// AcquireResult mirrors the Lua return tuple of originate_acquire.v1.
type AcquireResult struct {
	Allowed       bool
	NewActiveCount int64
}

// ErrGatewayLimit is returned by Acquire when the gateway cap blocks.
var ErrGatewayLimit = errors.New("valkey: gateway concurrent-call cap reached")

// Acquire performs the atomic gateway-cap check + in-flight HASH write.
// On block returns ErrGatewayLimit; ar.NewActiveCount is the current
// (pre-block) counter.
func (o *OriginateOps) Acquire(
	ctx context.Context,
	gatewayID, campaignID, leadID int64,
	callUUID string,
	maxConcurrent int,
	tsMs int64,
	inFlightTTLSec int,
) (AcquireResult, error) {
	if inFlightTTLSec <= 0 {
		inFlightTTLSec = 60
	}
	res, err := o.c.Scripts.Eval(
		ctx, o.c.State, ScriptOriginateAcquire,
		[]string{
			o.c.Keys.GatewayActive(gatewayID),
			o.c.Keys.InFlightCall(callUUID),
		},
		strconv.Itoa(maxConcurrent),
		callUUID,
		strconv.FormatInt(leadID, 10),
		strconv.FormatInt(campaignID, 10),
		strconv.FormatInt(gatewayID, 10),
		strconv.FormatInt(tsMs, 10),
		strconv.Itoa(inFlightTTLSec),
	)
	if err != nil {
		return AcquireResult{}, err
	}
	arr, ok := res.([]any)
	if !ok || len(arr) < 2 {
		return AcquireResult{}, fmt.Errorf("valkey: Acquire returned unexpected %T", res)
	}
	tag, _ := arr[0].(string)
	count, _ := strconv.ParseInt(toString(arr[1]), 10, 64)

	if tag == "OK" {
		return AcquireResult{Allowed: true, NewActiveCount: count}, nil
	}
	return AcquireResult{Allowed: false, NewActiveCount: count}, ErrGatewayLimit
}

// Release decrements the gateway counter and deletes the in-flight
// HASH. Idempotent: a second call on the same UUID returns NOOP.
//
// `released` is true only when the in-flight HASH existed and matched.
func (o *OriginateOps) Release(
	ctx context.Context,
	gatewayID int64,
	callUUID string,
) (released bool, newActive int64, err error) {
	res, err := o.c.Scripts.Eval(
		ctx, o.c.State, ScriptOriginateRelease,
		[]string{
			o.c.Keys.GatewayActive(gatewayID),
			o.c.Keys.InFlightCall(callUUID),
		},
		callUUID,
	)
	if err != nil {
		return false, 0, err
	}
	arr, ok := res.([]any)
	if !ok || len(arr) < 2 {
		return false, 0, fmt.Errorf("valkey: Release returned unexpected %T", res)
	}
	tag, _ := arr[0].(string)
	count, _ := strconv.ParseInt(toString(arr[1]), 10, 64)
	return tag == "OK", count, nil
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	default:
		return fmt.Sprint(x)
	}
}
