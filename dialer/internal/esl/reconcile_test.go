package esl

import (
	"encoding/json"
	"testing"
)

func TestParseShowChannelsJSON_Normal(t *testing.T) {
	type row struct {
		UUID string `json:"uuid"`
	}
	type result struct {
		RowCount int   `json:"rowCount"`
		Rows     []row `json:"rows"`
	}
	body, _ := json.Marshal(result{
		RowCount: 2,
		Rows: []row{
			{UUID: "uuid-a"},
			{UUID: "uuid-b"},
		},
	})
	got := parseShowChannelsJSON(body)
	if !got["uuid-a"] || !got["uuid-b"] {
		t.Errorf("expected uuid-a and uuid-b in result, got %v", got)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 UUIDs, got %d", len(got))
	}
}

func TestParseShowChannelsJSON_Empty(t *testing.T) {
	body := []byte(`{"rowCount":0,"rows":[]}`)
	got := parseShowChannelsJSON(body)
	if len(got) != 0 {
		t.Errorf("expected 0 UUIDs from empty result, got %d", len(got))
	}
}

func TestParseShowChannelsJSON_NonJSON(t *testing.T) {
	// FS sometimes returns a plaintext message on empty channel list.
	got := parseShowChannelsJSON([]byte("No current channels"))
	if len(got) != 0 {
		t.Errorf("expected empty map on non-JSON input, got %v", got)
	}
}

func TestParseShowChannelsJSON_NilBody(t *testing.T) {
	got := parseShowChannelsJSON(nil)
	if len(got) != 0 {
		t.Errorf("expected empty map on nil body")
	}
}
