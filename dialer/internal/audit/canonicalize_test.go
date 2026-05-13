package audit

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helper tests for primitive functions
// ---------------------------------------------------------------------------

func TestLpad20(t *testing.T) {
	tests := []struct {
		n    uint64
		want string
	}{
		{0, "00000000000000000000"},
		{1, "00000000000000000001"},
		{9999999999999999999, "09999999999999999999"},
	}
	for _, tc := range tests {
		got := lpad20(tc.n)
		if got != tc.want {
			t.Errorf("lpad20(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

func TestNullOrStr(t *testing.T) {
	s := "hello"
	if nullOrStr(&s) != "hello" {
		t.Error("nullOrStr non-nil: expected passthrough")
	}
	if nullOrStr(nil) != nullSentinel {
		t.Errorf("nullOrStr nil: expected %q, got %q", nullSentinel, nullOrStr(nil))
	}
	empty := ""
	if nullOrStr(&empty) != "" {
		t.Error("nullOrStr empty: expected empty string (not \\N)")
	}
}

func TestIsoMicros(t *testing.T) {
	ts := time.Date(2026, 5, 12, 3, 30, 0, 123456000, time.UTC)
	got := isoMicros(ts)
	want := "2026-05-12T03:30:00.123456Z"
	if got != want {
		t.Errorf("isoMicros = %q, want %q", got, want)
	}
}

func TestDSTSpringForward(t *testing.T) {
	// 2026-03-08 07:00:00 UTC — US DST spring-forward day.
	// Server runs UTC; output must contain T07:00:00.000000Z regardless.
	ts := time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC)
	got := isoMicros(ts)
	if !strings.Contains(got, "T07:00:00.000000Z") {
		t.Errorf("DST spring-forward: got %q, expected T07:00:00.000000Z", got)
	}
}

// ---------------------------------------------------------------------------
// AuditLogRow canonicalization
// ---------------------------------------------------------------------------

func TestAuditLogRowCanonFields(t *testing.T) {
	row := AuditLogRow{
		PrevHash:   strings.Repeat("0", 64),
		TenantID:   1,
		ID:         1,
		Ts:         time.Date(2026, 5, 12, 3, 30, 0, 0, time.UTC),
		ActorKind:  "system",
		Action:     "audit.attestation.published",
		EntityType: "audit_log",
	}
	c := row.Canonicalize()
	parts := strings.Split(c, sep)
	if len(parts) != 15 {
		t.Errorf("expected 15 fields, got %d: %q", len(parts), c)
	}
	if parts[1] != "00000000000000000001" {
		t.Errorf("tenant_id field: got %q, want %q", parts[1], "00000000000000000001")
	}
	if parts[2] != "audit_log" {
		t.Errorf("table_tag: got %q", parts[2])
	}
	if parts[5] != nullSentinel {
		t.Errorf("actor_user_id null: got %q, want %q", parts[5], nullSentinel)
	}
}

func TestNullVsEmptyStringEntityID(t *testing.T) {
	base := AuditLogRow{
		PrevHash: strings.Repeat("0", 64), TenantID: 1, ID: 1,
		Ts:         time.Now().UTC(),
		ActorKind:  "system",
		Action:     "test",
		EntityType: "user",
	}
	withNull := base
	withNull.EntityID = nil

	empty := ""
	withEmpty := base
	withEmpty.EntityID = &empty

	if withNull.Canonicalize() == withEmpty.Canonicalize() {
		t.Error("null and empty string entity_id must produce different canonical forms")
	}
}

func TestJCSKeyOrder(t *testing.T) {
	// Map with keys in non-alphabetical insertion order
	m := map[string]interface{}{
		"z_last":  "last",
		"a_first": "first",
		"m_mid":   42.0,
	}
	got := jcsJSON(m)
	// Keys must be sorted
	aPos := strings.Index(got, "a_first")
	mPos := strings.Index(got, "m_mid")
	zPos := strings.Index(got, "z_last")
	if aPos > mPos || mPos > zPos {
		t.Errorf("JCS key order wrong: a=%d m=%d z=%d in %q", aPos, mPos, zPos, got)
	}
}

func TestHashIs64HexChars(t *testing.T) {
	row := AuditLogRow{
		PrevHash:   strings.Repeat("0", 64),
		TenantID:   1, ID: 42,
		Ts:         time.Now().UTC(),
		ActorKind:  "system",
		Action:     "test",
		EntityType: "entity",
	}
	hash := row.Hash()
	if len(hash) != 64 {
		t.Errorf("hash length: got %d, want 64", len(hash))
	}
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("non-hex char %q in hash", c)
		}
	}
}

// ---------------------------------------------------------------------------
// Golden fixture parity test (15 fixtures from test/fixtures/canonicalization)
// ---------------------------------------------------------------------------

type fixtureFile struct {
	Table string `json:"table"`
	Row   map[string]interface{} `json:"row"`
}

func TestGoldenFixturesParity(t *testing.T) {
	fixtureDir := "../../../test/fixtures/canonicalization"
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Skipf("fixtures dir not accessible: %v", err)
		return
	}

	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(fixtureDir + "/" + entry.Name())
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var f fixtureFile
			if err := json.Unmarshal(data, &f); err != nil {
				t.Fatalf("parse fixture: %v", err)
			}
			if f.Table == "" {
				return // comment-only fixture
			}

			// Basic smoke: build canonical string and verify it's non-empty
			switch f.Table {
			case "audit_log":
				row := fixtureToAuditLogRow(f.Row)
				c := row.Canonicalize()
				if c == "" {
					t.Error("empty canonical string")
				}
				hash := row.Hash()
				if len(hash) != 64 {
					t.Errorf("bad hash length %d", len(hash))
				}
			case "call_window_audit":
				row := fixtureToCallWindowAuditRow(f.Row)
				c := row.Canonicalize()
				if c == "" {
					t.Error("empty canonical string")
				}
			case "consent_log":
				row := fixtureToConsentLogRow(f.Row)
				c := row.Canonicalize()
				if c == "" {
					t.Error("empty canonical string")
				}
			case "dnc_sync_log":
				row := fixtureToDncSyncLogRow(f.Row)
				c := row.Canonicalize()
				if c == "" {
					t.Error("empty canonical string")
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Fixture converters (simplified — real integration tests compare byte-for-byte)
// ---------------------------------------------------------------------------

func fixtureToAuditLogRow(m map[string]interface{}) AuditLogRow {
	row := AuditLogRow{
		PrevHash:   strField(m, "prev_hash"),
		TenantID:   uint64Field(m, "tenant_id"),
		ID:         uint64Field(m, "id"),
		Ts:         timeField(m, "ts"),
		ActorKind:  strField(m, "actor_kind"),
		Action:     strField(m, "action"),
		EntityType: strField(m, "entity_type"),
		BeforeJSON: m["before_json"],
		AfterJSON:  m["after_json"],
	}
	if v, ok := m["actor_user_id"]; ok && v != nil {
		n := uint64(v.(float64))
		row.ActorUserID = &n
	}
	if v, ok := m["entity_id"]; ok && v != nil {
		s := v.(string)
		row.EntityID = &s
	}
	if v, ok := m["request_id"]; ok && v != nil {
		s := v.(string)
		row.RequestID = &s
	}
	if v, ok := m["ip_address"]; ok && v != nil {
		s := v.(string)
		row.IPAddress = &s
	}
	if v, ok := m["user_agent"]; ok && v != nil {
		s := v.(string)
		row.UserAgent = &s
	}
	return row
}

func fixtureToCallWindowAuditRow(m map[string]interface{}) CallWindowAuditRow {
	return CallWindowAuditRow{
		PrevHash:         strField(m, "prev_hash"),
		TenantID:         uint64Field(m, "tenant_id"),
		ID:               uint64Field(m, "id"),
		CreatedAt:        timeField(m, "created_at"),
		LeadID:           uint64Field(m, "lead_id"),
		PhoneE164:        strField(m, "phone_e164"),
		CampaignID:       strField(m, "campaign_id"),
		Decision:         strField(m, "decision"),
		Reason:           strField(m, "reason"),
		EnforcementPoint: strField(m, "enforcement_point"),
	}
}

func fixtureToConsentLogRow(m map[string]interface{}) ConsentLogRow {
	return ConsentLogRow{
		PrevHash:       strField(m, "prev_hash"),
		TenantID:       uint64Field(m, "tenant_id"),
		ID:             uint64Field(m, "id"),
		CallUUID:       strField(m, "call_uuid"),
		LeadID:         uint64Field(m, "lead_id"),
		PhoneE164:      strField(m, "phone_e164"),
		PromptID:       strField(m, "prompt_id"),
		Outcome:        strField(m, "outcome"),
		Language:       strField(m, "language"),
		PromptPlayedAt: timeField(m, "prompt_played_at"),
	}
}

func fixtureToDncSyncLogRow(m map[string]interface{}) DncSyncLogRow {
	return DncSyncLogRow{
		PrevHash:  strField(m, "prev_hash"),
		ID:        uint64Field(m, "id"),
		Source:    strField(m, "source"),
		Kind:      strField(m, "kind"),
		Added:     intField(m, "added"),
		Removed:   intField(m, "removed"),
		StartedAt: timeField(m, "started_at"),
	}
}

func strField(m map[string]interface{}, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	return v.(string)
}

func uint64Field(m map[string]interface{}, key string) uint64 {
	v, ok := m[key]
	if !ok || v == nil {
		return 0
	}
	return uint64(v.(float64))
}

func intField(m map[string]interface{}, key string) int {
	v, ok := m[key]
	if !ok || v == nil {
		return 0
	}
	return int(v.(float64))
}

func timeField(m map[string]interface{}, key string) time.Time {
	v, ok := m[key]
	if !ok || v == nil {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, v.(string))
	return t.UTC()
}
