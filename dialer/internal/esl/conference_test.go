package esl

import (
	"encoding/json"
	"testing"
)

func TestParseConferenceList_Normal(t *testing.T) {
	input := map[string]interface{}{
		"conference_name": "agent_t1_u7",
		"members": []map[string]string{
			{"id": "1", "uuid": "uuid-a", "caller_num": "+15551234567", "caller_name": "Agent", "flags": "mute|floor"},
			{"id": "2", "uuid": "uuid-b", "caller_num": "+14155550100", "caller_name": "Customer", "flags": ""},
		},
	}
	body, _ := json.Marshal(input)
	members, err := parseConferenceList(string(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %d", len(members))
	}
	if members[0].MemberID != "1" || members[0].UUID != "uuid-a" {
		t.Errorf("unexpected member[0]: %+v", members[0])
	}
	if len(members[0].Flags) != 2 {
		t.Errorf("expected 2 flags, got %d: %v", len(members[0].Flags), members[0].Flags)
	}
	if len(members[1].Flags) != 0 {
		t.Errorf("expected 0 flags for empty member, got: %v", members[1].Flags)
	}
}

func TestParseConferenceList_Empty(t *testing.T) {
	members, err := parseConferenceList("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if members != nil {
		t.Errorf("expected nil members on empty reply")
	}
}

func TestParseConferenceList_OKReply(t *testing.T) {
	members, err := parseConferenceList("+OK")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if members != nil {
		t.Errorf("expected nil on '+OK' reply")
	}
}

func TestParseConferenceList_NotFound(t *testing.T) {
	members, err := parseConferenceList("-ERR Conference not found")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if members != nil {
		t.Errorf("expected nil on not-found reply")
	}
}
