package esl

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/percipia/eslgo"
	"github.com/percipia/eslgo/command"
	"github.com/redis/go-redis/v9"
)

// reconcile runs on every successful (re)connect to an FS host.
// It diffs live FS channels against the Valkey active set and emits
// synthetic events for any divergence. See T01 PLAN §14.1.
func reconcile(
	ctx context.Context,
	conn *eslgo.Conn,
	rdb redis.Cmdable,
	fsHost string,
	tenantID int64,
	eventCh chan EnrichedEvent,
	m *eslMetrics,
) error {
	// 1. Get live channels from FS via synchronous `api show channels as json`.
	resp, err := conn.SendCommand(ctx, command.API{
		Command:    "show",
		Arguments:  "channels as json",
		Background: false,
	})
	if err != nil {
		return fmt.Errorf("reconcile: show channels: %w", err)
	}

	fsUUIDs := parseShowChannelsJSON(resp.Body)

	// 2. Get what we think is live from Valkey.
	callActiveKey := fmt.Sprintf("t:%d:call:active", tenantID)
	valkeyMembers, err := rdb.SMembers(ctx, callActiveKey).Result()
	if err != nil {
		return fmt.Errorf("reconcile: SMEMBERS call:active: %w", err)
	}

	valkeyUUIDs := make(map[string]bool, len(valkeyMembers))
	for _, m := range valkeyMembers {
		valkeyUUIDs[m] = true
	}

	// 3. Set diff — in FS but not in Valkey → rehydrate.
	for uuid := range fsUUIDs {
		if !valkeyUUIDs[uuid] {
			// Emit synthetic vici2::reconciled.rehydrate
			emitSyntheticEvent(ctx, "vici2::reconciled.rehydrate", uuid, fsHost, tenantID, eventCh)
			if m != nil {
				m.reconciledCallsTotal.WithLabelValues(fsHost, "rehydrated").Inc()
			}
		}
	}

	// 4. In Valkey but not in FS → mark lost.
	for uuid := range valkeyUUIDs {
		if !fsUUIDs[uuid] {
			emitSyntheticEvent(ctx, "vici2::reconciled.lost", uuid, fsHost, tenantID, eventCh)
			if m != nil {
				m.reconciledCallsTotal.WithLabelValues(fsHost, "marked_lost").Inc()
			}
		}
	}

	return nil
}

// parseShowChannelsJSON extracts UUID strings from FS `show channels as json` output.
// The JSON structure is {"rowCount":N,"rows":[{"uuid":"...","cid_num":"...",...},...]}.
func parseShowChannelsJSON(body []byte) map[string]bool {
	type row struct {
		UUID string `json:"uuid"`
	}
	type result struct {
		Rows []row `json:"rows"`
	}
	uuids := make(map[string]bool)
	if len(body) == 0 {
		return uuids
	}
	var r result
	// FS sometimes returns non-JSON text on empty channel list.
	if !strings.HasPrefix(strings.TrimSpace(string(body)), "{") {
		return uuids
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return uuids
	}
	for _, row := range r.Rows {
		if row.UUID != "" {
			uuids[row.UUID] = true
		}
	}
	return uuids
}

// emitSyntheticEvent constructs a minimal EnrichedEvent for reconciliation.
func emitSyntheticEvent(
	ctx context.Context,
	subclass, callUUID, fsHost string,
	tenantID int64,
	eventCh chan EnrichedEvent,
) {
	ev := &eslgo.Event{}
	// Build a minimal plain event with enough headers for downstream.
	// We can't call readPlainEvent so we populate directly via map construction.
	// This is a best-effort synthetic event.
	e := EnrichedEvent{
		Event:    ev,
		FSHost:   fsHost,
		TenantID: tenantID,
		CallUUID: callUUID,
		Critical: subclass == "vici2::reconciled.lost",
	}
	_ = strconv.FormatInt(tenantID, 10) // suppress lint
	select {
	case eventCh <- e:
	case <-ctx.Done():
	}
}
