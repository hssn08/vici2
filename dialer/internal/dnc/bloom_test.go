package dnc

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// miniredis doesn't support BF.* commands; we verify graceful fail-closed
// behaviour: bloomMexists should return positive=true on unknown-command error.

func TestBloomMexists_FailClosed(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	hits := bloomMexists(context.Background(), rdb, []Source{SourceFederal, SourceInternal}, 1, "+14155551212")

	// miniredis returns ERR for BF.EXISTS → fail-closed → all positive
	if !hits[SourceFederal] {
		t.Error("expected SourceFederal to be fail-closed positive")
	}
	if !hits[SourceInternal] {
		t.Error("expected SourceInternal to be fail-closed positive")
	}
}

func TestBloomKey_Coverage(t *testing.T) {
	if bloomKey("unknown", 1) == "" {
		t.Error("bloomKey should return a non-empty string for unknown source")
	}
}

func TestBloomMadd_Empty(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	// Empty batch should not error
	err := BloomMadd(context.Background(), rdb, SourceFederal, 0, nil)
	if err != nil {
		t.Fatalf("BloomMadd(empty) should not error: %v", err)
	}
}

func TestReserveBloom_BusyKey(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	// miniredis returns unknown command error; not BUSYKEY → error expected
	// (this tests that we don't panic)
	_ = ReserveBloom(context.Background(), rdb, SourceFederal, 0, 300_000_000, 0.001)
}
