// Package testutil provides testing helpers for the esl package.
package testutil

import "fmt"

// ChannelCreateEvent returns a minimal ESL plain-text CHANNEL_CREATE event.
func ChannelCreateEvent(uuid, leadID, agentID, campaignID, tenantID string) string {
	return fmt.Sprintf(`Event-Name: CHANNEL_CREATE
Unique-Id: %s
Call-Direction: outbound
variable_lead_id: %s
variable_agent_id: %s
variable_campaign_id: %s
variable_tenant_id: %s
variable_origination_uuid: %s
Answer-State: ringing

`, uuid, leadID, agentID, campaignID, tenantID, uuid)
}

// ChannelAnswerEvent returns a minimal CHANNEL_ANSWER event.
func ChannelAnswerEvent(uuid string) string {
	return fmt.Sprintf(`Event-Name: CHANNEL_ANSWER
Unique-Id: %s
Answer-State: answered

`, uuid)
}

// ChannelHangupCompleteEvent returns a minimal CHANNEL_HANGUP_COMPLETE event.
func ChannelHangupCompleteEvent(uuid, cause string) string {
	return fmt.Sprintf(`Event-Name: CHANNEL_HANGUP_COMPLETE
Unique-Id: %s
Hangup-Cause: %s
variable_originate_disposition: %s

`, uuid, cause, cause)
}

// BackgroundJobEvent returns a minimal BACKGROUND_JOB event with the given body.
func BackgroundJobEvent(jobUUID, body string) string {
	return fmt.Sprintf(`Event-Name: BACKGROUND_JOB
Job-Uuid: %s
Content-Length: %d

%s`, jobUUID, len(body), body)
}

// HeartbeatEvent returns a minimal HEARTBEAT event.
func HeartbeatEvent() string {
	return `Event-Name: HEARTBEAT
Event-Info: System Ready

`
}

// ConferenceMemberAddEvent returns a CUSTOM conference::maintenance add-member event.
func ConferenceMemberAddEvent(confName, memberID, uuid string) string {
	return fmt.Sprintf(`Event-Name: CUSTOM
Event-Subclass: conference::maintenance
Conference-Name: %s
Action: add-member
Member-Id: %s
Unique-Id: %s

`, confName, memberID, uuid)
}
