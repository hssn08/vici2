package dnc

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// bloomKey returns the Valkey key for a given source + tenant.
func bloomKey(src Source, tenantID int64) string {
	switch src {
	case SourceFederal:
		return "bf:dnc:federal"
	case SourceLitigator:
		return "bf:dnc:litigator"
	case SourceInternal:
		return fmt.Sprintf("t:%d:dnc:internal:bloom", tenantID)
	case SourceState:
		return fmt.Sprintf("t:%d:dnc:state:bloom", tenantID)
	default:
		return fmt.Sprintf("bf:dnc:unknown:%s", src)
	}
}

// bloomMexists pipelines BF.EXISTS across sources in one RTT.
// Returns map[source]→positive.  On pipeline error, all sources return true
// (fail-closed per PLAN §1.5).
func bloomMexists(
	ctx context.Context,
	rdb redis.UniversalClient,
	sources []Source,
	tenantID int64,
	phone string,
) map[Source]bool {
	pipe := rdb.Pipeline()
	cmds := make([]*redis.Cmd, len(sources))
	for i, src := range sources {
		key := bloomKey(src, tenantID)
		cmds[i] = pipe.Do(ctx, "BF.EXISTS", key, phone)
	}

	_, execErr := pipe.Exec(ctx)

	result := make(map[Source]bool, len(sources))
	for i, src := range sources {
		if execErr != nil {
			// Fail-closed: Valkey completely down
			result[src] = true
			continue
		}
		if cmds[i].Err() != nil {
			// Individual command error (key missing, module not loaded) → fail-closed
			result[src] = true
			continue
		}
		v, err := cmds[i].Int()
		result[src] = err == nil && v == 1
	}
	return result
}

// ReserveBloom idempotently reserves a Bloom filter.
// BUSYKEY (already exists) is silently swallowed.
func ReserveBloom(
	ctx context.Context,
	rdb redis.UniversalClient,
	src Source,
	tenantID int64,
	capacity int64,
	fpr float64,
) error {
	key := bloomKey(src, tenantID)
	err := rdb.Do(ctx, "BF.RESERVE", key, fpr, capacity, "EXPANSION", 2).Err()
	if err != nil && err.Error() != "ERR item exists" {
		return err
	}
	return nil
}

// BloomAdd adds a single phone to a Bloom filter.
func BloomAdd(
	ctx context.Context,
	rdb redis.UniversalClient,
	src Source,
	tenantID int64,
	phone string,
) error {
	key := bloomKey(src, tenantID)
	return rdb.Do(ctx, "BF.ADD", key, phone).Err()
}

// BloomMadd adds a batch of phones to a Bloom filter.
func BloomMadd(
	ctx context.Context,
	rdb redis.UniversalClient,
	src Source,
	tenantID int64,
	phones []string,
) error {
	if len(phones) == 0 {
		return nil
	}
	key := bloomKey(src, tenantID)
	args := make([]interface{}, 0, len(phones)+2)
	args = append(args, "BF.MADD", key)
	for _, p := range phones {
		args = append(args, p)
	}
	return rdb.Do(ctx, args...).Err()
}
