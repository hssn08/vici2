package esl

import (
	"strings"
	"testing"
)

func TestBuildChannelVars_AllFields(t *testing.T) {
	req := OriginateRequest{
		PreSuppliedUUID:  "uuid-123",
		CallerIDNumber:   "+15551234567",
		CallerIDName:     "ACME",
		OriginateTimeout: 30,
		OnAnswer:         OnAnswerPark{},
		LeadID:           42,
		AgentID:          7,
		CampaignID:       99,
		TenantID:         1,
		GatewayName:      "twilio_main",
		DestNumber:       "+14155550100",
	}

	got := buildChannelVars(req)

	// Must be wrapped in {}.
	if !strings.HasPrefix(got, "{") || !strings.HasSuffix(got, "}") {
		t.Fatalf("expected {}-wrapped vars, got: %q", got)
	}
	inner := strings.TrimPrefix(strings.TrimSuffix(got, "}"), "{")
	vars := strings.Split(inner, ",")
	varMap := make(map[string]string, len(vars))
	for _, v := range vars {
		parts := strings.SplitN(v, "=", 2)
		if len(parts) == 2 {
			varMap[parts[0]] = parts[1]
		}
	}

	checks := map[string]string{
		"origination_uuid":                    "uuid-123",
		"origination_caller_id_number":        "+15551234567",
		"origination_caller_id_name":          "ACME",
		"originate_timeout":                   "30",
		"execute_on_answer":                   "park",
		"lead_id":                             "42",
		"agent_id":                            "7",
		"campaign_id":                         "99",
		"tenant_id":                           "1",
		"hangup_after_bridge":                 "true",
		"ignore_early_media":                  "true",
	}
	for k, want := range checks {
		if got := varMap[k]; got != want {
			t.Errorf("var %q: got %q, want %q", k, got, want)
		}
	}
}

func TestBuildChannelVars_OnAnswerConference(t *testing.T) {
	req := OriginateRequest{
		OnAnswer: OnAnswerConference{Name: "agent_t1_u7"},
	}
	got := buildChannelVars(req)
	if !strings.Contains(got, "execute_on_answer=transfer:agent_t1_u7 XML default") {
		t.Errorf("OnAnswerConference: unexpected vars: %q", got)
	}
}

func TestBuildChannelVars_OnAnswerBridge(t *testing.T) {
	req := OriginateRequest{
		OnAnswer: OnAnswerBridge{Endpoint: "sofia/gateway/gw1/+14155550000"},
	}
	got := buildChannelVars(req)
	if !strings.Contains(got, "execute_on_answer=bridge:sofia/gateway/gw1/+14155550000") {
		t.Errorf("OnAnswerBridge: unexpected vars: %q", got)
	}
}

func TestBuildChannelVars_OnAnswerCustom(t *testing.T) {
	req := OriginateRequest{
		OnAnswer: OnAnswerCustom{Raw: "eavesdrop:other-uuid XML default"},
	}
	got := buildChannelVars(req)
	if !strings.Contains(got, "execute_on_answer=eavesdrop:other-uuid XML default") {
		t.Errorf("OnAnswerCustom: unexpected vars: %q", got)
	}
}

func TestBgapiWithJobUUID_BuildMessage(t *testing.T) {
	cmd := &bgapiWithJobUUID{
		cmd:     "bgapi originate {origination_uuid=abc}sofia/gateway/gw/+1 &park()",
		jobUUID: "job-uuid-xyz",
	}
	msg := cmd.BuildMessage()
	if !strings.Contains(msg, "bgapi originate") {
		t.Errorf("expected bgapi in message, got: %q", msg)
	}
	if !strings.Contains(msg, "Job-UUID: job-uuid-xyz") {
		t.Errorf("expected Job-UUID header in message, got: %q", msg)
	}
}
