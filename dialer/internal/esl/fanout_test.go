package esl

import (
	"context"
	"net/textproto"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/percipia/eslgo"
	"github.com/redis/go-redis/v9"
)

func newTestRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return mr, rdb
}

func makeEnrichedEvent(name string, tenantID, agentID, campaignID int64, callUUID string) EnrichedEvent {
	ev := &eslgo.Event{Headers: make(textproto.MIMEHeader)}
	ev.Headers.Set("Event-Name", name)
	ev.Headers.Set("Unique-Id", callUUID)
	return EnrichedEvent{
		Event:      ev,
		FSHost:     "fs1:8021",
		TenantID:   tenantID,
		AgentID:    agentID,
		CampaignID: campaignID,
		CallUUID:   callUUID,
		ReceivedAt: time.Now(),
		Critical:   criticalEvents[name],
	}
}

func TestEventStreamName(t *testing.T) {
	cases := []struct {
		name      string
		headers   map[string]string
		wantStream string
	}{
		{"CHANNEL_CREATE", nil, "events:vici2.call.created"},
		{"CHANNEL_ANSWER", nil, "events:vici2.call.answered"},
		{"CHANNEL_BRIDGE", nil, "events:vici2.call.bridged"},
		{"CHANNEL_HANGUP_COMPLETE", nil, "events:vici2.call.ended"},
		{"RECORD_START", nil, "events:vici2.recording.started"},
		{"RECORD_STOP", nil, "events:vici2.recording.stopped"},
		{"BACKGROUND_JOB", nil, ""},
		{"HEARTBEAT", nil, ""},
		{"DTMF", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := makeEnrichedEvent(tc.name, 1, 0, 0, "u1")
			if tc.headers != nil {
				for k, v := range tc.headers {
					e.Headers.Set(k, v)
				}
			}
			got := eventStreamName(e)
			if got != tc.wantStream {
				t.Errorf("got %q, want %q", got, tc.wantStream)
			}
		})
	}
}

func TestPublishStream_WritesXADD(t *testing.T) {
	_, rdb := newTestRedis(t)
	ctx := context.Background()

	e := makeEnrichedEvent("CHANNEL_CREATE", 1, 7, 99, "call-uuid-stream")
	publishStream(ctx, rdb, "events:vici2.call.created", e, nil)

	// Verify the stream entry was written.
	msgs, err := rdb.XRange(ctx, "events:vici2.call.created", "-", "+").Result()
	if err != nil {
		t.Fatalf("XRange: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 stream entry, got %d", len(msgs))
	}
	if msgs[0].Values["call_uuid"] != "call-uuid-stream" {
		t.Errorf("unexpected call_uuid: %v", msgs[0].Values["call_uuid"])
	}
}

func TestPubSubChannels_AgentAndCampaign(t *testing.T) {
	e := makeEnrichedEvent("CHANNEL_CREATE", 1, 7, 99, "u1")
	channels := pubSubChannels(e)
	if len(channels) != 2 {
		t.Fatalf("expected 2 channels, got %d: %v", len(channels), channels)
	}
}

func TestPubSubChannels_DTMF(t *testing.T) {
	e := makeEnrichedEvent("DTMF", 1, 0, 0, "call-dtmf-uuid")
	channels := pubSubChannels(e)
	if len(channels) != 1 {
		t.Fatalf("expected 1 DTMF channel, got %d", len(channels))
	}
	want := "t:1:broadcast:call:call-dtmf-uuid:dtmf"
	if channels[0] != want {
		t.Errorf("got %q, want %q", channels[0], want)
	}
}

func TestWriteDropWindow_DroppedCall(t *testing.T) {
	_, rdb := newTestRedis(t)
	ctx := context.Background()

	e := makeEnrichedEvent("CHANNEL_HANGUP_COMPLETE", 1, 0, 42, "drop-uuid")
	e.Event.Headers.Set("Hangup-Cause", "NO_ANSWER")

	writeDropWindow(ctx, rdb, e)

	stream := "t:1:campaign:{42}:drop_window"
	msgs, err := rdb.XRange(ctx, stream, "-", "+").Result()
	if err != nil {
		t.Fatalf("XRange: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 drop_window entry, got %d", len(msgs))
	}
	if msgs[0].Values["dropped"] != "1" {
		t.Errorf("expected dropped=1, got: %v", msgs[0].Values["dropped"])
	}
	if msgs[0].Values["answered"] != "0" {
		t.Errorf("expected answered=0, got: %v", msgs[0].Values["answered"])
	}
}

func TestWriteDropWindow_AnsweredCall(t *testing.T) {
	_, rdb := newTestRedis(t)
	ctx := context.Background()

	e := makeEnrichedEvent("CHANNEL_HANGUP_COMPLETE", 1, 0, 42, "ans-uuid")
	e.Event.Headers.Set("Hangup-Cause", "NORMAL_CLEARING")

	writeDropWindow(ctx, rdb, e)

	stream := "t:1:campaign:{42}:drop_window"
	msgs, _ := rdb.XRange(ctx, stream, "-", "+").Result()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(msgs))
	}
	if msgs[0].Values["answered"] != "1" || msgs[0].Values["dropped"] != "0" {
		t.Errorf("expected answered=1 dropped=0, got: %v", msgs[0].Values)
	}
}
