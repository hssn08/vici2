package esl

import (
	"context"
	"net/textproto"
	"testing"
	"time"

	"github.com/percipia/eslgo"
)

func makeTestEvent(headers map[string]string) *eslgo.Event {
	ev := &eslgo.Event{Headers: make(textproto.MIMEHeader)}
	for k, v := range headers {
		ev.Headers.Set(k, v)
	}
	return ev
}

func TestEnrichEvent_FromChannelVars(t *testing.T) {
	ev := makeTestEvent(map[string]string{
		"Event-Name":          "CHANNEL_CREATE",
		"Unique-Id":           "call-uuid-1",
		"variable_lead_id":    "42",
		"variable_agent_id":   "7",
		"variable_campaign_id": "99",
		"variable_tenant_id":  "1",
	})

	e := enrichEvent(context.Background(), ev, "fs1:8021", nil, 1, nil)

	if e.CallUUID != "call-uuid-1" {
		t.Errorf("CallUUID: got %q", e.CallUUID)
	}
	if e.LeadID != 42 {
		t.Errorf("LeadID: got %d", e.LeadID)
	}
	if e.AgentID != 7 {
		t.Errorf("AgentID: got %d", e.AgentID)
	}
	if e.CampaignID != 99 {
		t.Errorf("CampaignID: got %d", e.CampaignID)
	}
	if e.TenantID != 1 {
		t.Errorf("TenantID: got %d", e.TenantID)
	}
	if e.FSHost != "fs1:8021" {
		t.Errorf("FSHost: got %q", e.FSHost)
	}
	if e.ReceivedAt.IsZero() {
		t.Error("ReceivedAt is zero")
	}
}

func TestEnrichEvent_CriticalEvents(t *testing.T) {
	cases := []struct {
		name     string
		headers  map[string]string
		critical bool
	}{
		{"CHANNEL_HANGUP_COMPLETE", map[string]string{"Event-Name": "CHANNEL_HANGUP_COMPLETE"}, true},
		{"CHANNEL_BRIDGE", map[string]string{"Event-Name": "CHANNEL_BRIDGE"}, true},
		{"RECORD_STOP", map[string]string{"Event-Name": "RECORD_STOP"}, true},
		{"BACKGROUND_JOB", map[string]string{"Event-Name": "BACKGROUND_JOB"}, true},
		{"CHANNEL_CREATE", map[string]string{"Event-Name": "CHANNEL_CREATE"}, false},
		{"CHANNEL_ANSWER", map[string]string{"Event-Name": "CHANNEL_ANSWER"}, false},
		{"DTMF", map[string]string{"Event-Name": "DTMF"}, false},
		{
			"conference del-member",
			map[string]string{
				"Event-Name":      "CUSTOM",
				"Event-Subclass":  "conference::maintenance",
				"Action":          "del-member",
			},
			true,
		},
		{
			"conference add-member",
			map[string]string{
				"Event-Name":      "CUSTOM",
				"Event-Subclass":  "conference::maintenance",
				"Action":          "add-member",
			},
			false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := makeTestEvent(tc.headers)
			e := enrichEvent(context.Background(), ev, "fs1", nil, 1, nil)
			if e.Critical != tc.critical {
				t.Errorf("event %q: Critical=%v, want %v", tc.name, e.Critical, tc.critical)
			}
		})
	}
}

func TestInFlightKey(t *testing.T) {
	got := inFlightKey(1, "abc-uuid")
	want := "t:1:in_flight:{abc-uuid}"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestEnrichEvent_TimestampSet(t *testing.T) {
	before := time.Now()
	ev := makeTestEvent(map[string]string{"Event-Name": "HEARTBEAT"})
	e := enrichEvent(context.Background(), ev, "fs1", nil, 1, nil)
	after := time.Now()
	if e.ReceivedAt.Before(before) || e.ReceivedAt.After(after) {
		t.Errorf("ReceivedAt %v not in [%v, %v]", e.ReceivedAt, before, after)
	}
}
