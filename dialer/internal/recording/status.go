package recording

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// LifecycleState tracks the current state of a recording for a single call.
type LifecycleState string

const (
	StateRecording LifecycleState = "recording"
	StateMasked    LifecycleState = "masked"
	StateStopped   LifecycleState = "stopped"
	StateFailed    LifecycleState = "failed"
	StateNotActive LifecycleState = "not_active"
)

// RecordingStatus is returned by Recorder.RecordingStatus.
type RecordingStatus struct {
	CallUUID   string
	Path       string
	State      LifecycleState
	StartedAt  time.Time
	PausedAt   *time.Time // last mask time; nil if not currently masked
	ResumedAt  *time.Time // last unmask time
	PauseCount int        // total mask invocations this call
}

// recordingHashTTL is the Valkey HASH TTL for active recording state.
// 24h covers any realistic call (Phase 2 may extend for 4-hour runaway protection).
const recordingHashTTL = 24 * time.Hour

// recordingKey returns the Valkey HASH key for a given tenant+call.
// Pattern: t:{tenant_id}:recording:{call_uuid}
// Per R01 PLAN §7.4.
func recordingKey(tenantID int64, callUUID string) string {
	return fmt.Sprintf("t:%d:recording:%s", tenantID, callUUID)
}

// statusStore is an internal Valkey-backed recording-state store.
type statusStore struct {
	rdb      redis.Cmdable
	tenantID int64
}

// write atomically writes all recording-state fields into the Valkey HASH
// and (re)sets the 24h TTL.
func (s *statusStore) write(ctx context.Context, callUUID, path string, state LifecycleState, startedAt time.Time, pausedAtNs, resumedAtNs int64, pauseCount int, campaignID string, leadID int64) error {
	key := recordingKey(s.tenantID, callUUID)
	pipe := s.rdb.Pipeline()
	pipe.HSet(ctx, key,
		"path", path,
		"state", string(state),
		"started_at", startedAt.UnixNano(),
		"paused_at", pausedAtNs,
		"resumed_at", resumedAtNs,
		"pause_count", pauseCount,
		"campaign_id", campaignID,
		"lead_id", leadID,
	)
	pipe.Expire(ctx, key, recordingHashTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// read fetches the current recording state for the given call.
// Returns (zero RecordingStatus, ErrCallNotActive) if the key does not exist.
func (s *statusStore) read(ctx context.Context, callUUID string) (RecordingStatus, error) {
	key := recordingKey(s.tenantID, callUUID)
	vals, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return RecordingStatus{}, fmt.Errorf("valkey HGetAll: %w", err)
	}
	if len(vals) == 0 {
		return RecordingStatus{
			CallUUID: callUUID,
			State:    StateNotActive,
		}, ErrCallNotActive
	}

	rs := RecordingStatus{
		CallUUID: callUUID,
		Path:     vals["path"],
		State:    LifecycleState(vals["state"]),
	}

	if ns, err := strconv.ParseInt(vals["started_at"], 10, 64); err == nil && ns > 0 {
		t := time.Unix(0, ns).UTC()
		rs.StartedAt = t
	}
	if ns, err := strconv.ParseInt(vals["paused_at"], 10, 64); err == nil && ns > 0 {
		t := time.Unix(0, ns).UTC()
		rs.PausedAt = &t
	}
	if ns, err := strconv.ParseInt(vals["resumed_at"], 10, 64); err == nil && ns > 0 {
		t := time.Unix(0, ns).UTC()
		rs.ResumedAt = &t
	}
	if pc, err := strconv.Atoi(vals["pause_count"]); err == nil {
		rs.PauseCount = pc
	}
	return rs, nil
}

// setState updates only the state field (and TTL) without a full rewrite.
func (s *statusStore) setState(ctx context.Context, callUUID string, state LifecycleState) error {
	key := recordingKey(s.tenantID, callUUID)
	pipe := s.rdb.Pipeline()
	pipe.HSet(ctx, key, "state", string(state))
	pipe.Expire(ctx, key, recordingHashTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// del removes the recording HASH (called by T01 stream consumer on RECORD_STOP).
func (s *statusStore) del(ctx context.Context, callUUID string) error {
	return s.rdb.Del(ctx, recordingKey(s.tenantID, callUUID)).Err()
}
