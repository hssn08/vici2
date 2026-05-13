package esl

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// streamMaxLen is the MAXLEN ~ approximation for all Valkey Streams.
const streamMaxLen = 1_000_000

// eventStreamName maps event names / conference actions to Stream names.
// Returns "" if the event should not be written to a Stream.
func eventStreamName(e EnrichedEvent) string {
	name := e.GetName()
	switch name {
	case "CHANNEL_CREATE":
		return "events:vici2.call.created"
	case "CHANNEL_ANSWER":
		return "events:vici2.call.answered"
	case "CHANNEL_BRIDGE":
		return "events:vici2.call.bridged"
	case "CHANNEL_UNBRIDGE":
		return "events:vici2.call.unbridged"
	case "CHANNEL_HANGUP":
		return "events:vici2.call.hangup"
	case "CHANNEL_HANGUP_COMPLETE":
		return "events:vici2.call.ended"
	case "RECORD_START":
		return "events:vici2.recording.started"
	case "RECORD_STOP":
		return "events:vici2.recording.stopped"
	case "CUSTOM":
		sub := e.GetHeader("Event-Subclass")
		if sub == "conference::maintenance" {
			return conferenceStream(e.GetHeader("Action"))
		}
		if strings.HasPrefix(sub, "vici2::") {
			suffix := strings.TrimPrefix(sub, "vici2::")
			suffix = strings.ReplaceAll(suffix, "::", ".")
			return "events:vici2." + suffix
		}
	}
	return "" // BACKGROUND_JOB, HEARTBEAT, DTMF → no stream
}

func conferenceStream(action string) string {
	switch action {
	case "add-member":
		return "events:vici2.conference.member_added"
	case "del-member":
		return "events:vici2.conference.member_left"
	case "conference-create":
		return "events:vici2.conference.created"
	case "conference-destroy":
		return "events:vici2.conference.destroyed"
	}
	return ""
}

// publishStream writes the EnrichedEvent to a Valkey Stream via XADD.
func publishStream(ctx context.Context, rdb redis.Cmdable, stream string, e EnrichedEvent, m *eslMetrics) {
	payload, err := eventPayload(e)
	if err != nil {
		if m != nil {
			m.streamsXaddTotal.WithLabelValues(stream, "marshal_error").Inc()
		}
		return
	}

	args := &redis.XAddArgs{
		Stream: stream,
		MaxLen: streamMaxLen,
		Approx: true,
		ID:     "*",
		Values: map[string]interface{}{
			"event":       payload,
			"tenant_id":   strconv.FormatInt(e.TenantID, 10),
			"call_uuid":   e.CallUUID,
			"fs_host":     e.FSHost,
			"received_at": strconv.FormatInt(e.ReceivedAt.UnixMilli(), 10),
		},
	}

	if err := rdb.XAdd(ctx, args).Err(); err != nil {
		if m != nil {
			m.streamsXaddTotal.WithLabelValues(stream, "error").Inc()
		}
		return
	}
	if m != nil {
		m.streamsXaddTotal.WithLabelValues(stream, "ok").Inc()
	}
}

// pubSubChannels returns the list of Valkey pub/sub channels for an event.
func pubSubChannels(e EnrichedEvent) []string {
	var channels []string
	name := e.GetName()

	switch name {
	case "CHANNEL_CREATE", "CHANNEL_ANSWER":
		if e.AgentID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:agent:%d", e.TenantID, e.AgentID))
		}
		if e.CampaignID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:campaign:%d", e.TenantID, e.CampaignID))
		}
	case "CHANNEL_BRIDGE", "CHANNEL_UNBRIDGE", "CHANNEL_HANGUP":
		if e.AgentID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:agent:%d", e.TenantID, e.AgentID))
		}
	case "CHANNEL_HANGUP_COMPLETE":
		if e.AgentID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:agent:%d", e.TenantID, e.AgentID))
		}
		if e.CampaignID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:campaign:%d", e.TenantID, e.CampaignID))
		}
	case "DTMF":
		if e.CallUUID != "" {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:call:%s:dtmf", e.TenantID, e.CallUUID))
		}
	case "CUSTOM":
		sub := e.GetHeader("Event-Subclass")
		if sub == "conference::maintenance" && e.AgentID != 0 {
			channels = append(channels,
				fmt.Sprintf("t:%d:broadcast:agent:%d", e.TenantID, e.AgentID))
		}
	}
	return channels
}

// publishPubSub sends the enriched event payload to one or more pub/sub channels.
func publishPubSub(ctx context.Context, rdb redis.Cmdable, channels []string, e EnrichedEvent, m *eslMetrics) {
	if len(channels) == 0 {
		return
	}
	payload, err := eventPayload(e)
	if err != nil {
		return
	}

	for _, ch := range channels {
		class := channelClass(ch)
		if err := rdb.Publish(ctx, ch, payload).Err(); err != nil {
			if m != nil {
				m.pubsubPublishTotal.WithLabelValues(class, "error").Inc()
			}
		} else {
			if m != nil {
				m.pubsubPublishTotal.WithLabelValues(class, "ok").Inc()
			}
		}
	}
}

// channelClass extracts the class (agent|campaign|call|wallboard) from a
// pub/sub channel name for metrics labelling.
func channelClass(ch string) string {
	switch {
	case strings.Contains(ch, ":broadcast:agent:"):
		return "agent"
	case strings.Contains(ch, ":broadcast:campaign:"):
		return "campaign"
	case strings.Contains(ch, ":broadcast:call:"):
		return "call"
	case strings.Contains(ch, ":broadcast:wallboard"):
		return "wallboard"
	}
	return "other"
}

// eventPayload serialises an EnrichedEvent to a JSON string for pub/sub + Stream.
// It includes key headers plus the correlation IDs.
func eventPayload(e EnrichedEvent) (string, error) {
	m := map[string]interface{}{
		"event_name":  e.GetName(),
		"call_uuid":   e.CallUUID,
		"fs_host":     e.FSHost,
		"tenant_id":   e.TenantID,
		"lead_id":     e.LeadID,
		"agent_id":    e.AgentID,
		"campaign_id": e.CampaignID,
		"received_at": e.ReceivedAt.UnixMilli(),
	}
	// Include important headers.
	for _, h := range []string{
		"Answer-State", "Hangup-Cause", "Call-Direction",
		"Caller-Caller-Id-Number", "Caller-Destination-Number",
		"variable_vici2_role", "variable_vici2_conf_name",
		"variable_vici2_consent_status",
		"Event-Subclass", "Action",
		"Record-File-Path", "Record-Ms",
		"Job-UUID",
	} {
		if v := e.GetHeader(h); v != "" {
			m[h] = v
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// writeDropWindow writes an XADD for the adaptive-engine drop window
// on CHANNEL_HANGUP_COMPLETE events (PLAN §10.3).
func writeDropWindow(ctx context.Context, rdb redis.Cmdable, e EnrichedEvent) {
	if e.GetName() != "CHANNEL_HANGUP_COMPLETE" || e.CampaignID == 0 {
		return
	}
	cause := e.GetHeader("Hangup-Cause")
	dropCauses := map[string]bool{
		"USER_BUSY": true, "NO_USER_RESPONSE": true, "NO_ANSWER": true,
		"ORIGINATOR_CANCEL": true, "CALL_REJECTED": true,
		"NETWORK_OUT_OF_ORDER": true, "RECOVERY_ON_TIMER_EXPIRE": true,
	}
	answered := "0"
	dropped := "1"
	if !dropCauses[cause] {
		// treat as answered (bridged)
		answered = "1"
		dropped = "0"
	}

	stream := fmt.Sprintf("t:%d:campaign:{%d}:drop_window", e.TenantID, e.CampaignID)
	rdb.XAdd(ctx, &redis.XAddArgs{ //nolint:errcheck // best-effort
		Stream: stream,
		MaxLen: 500_000,
		Approx: true,
		ID:     "*",
		Values: map[string]interface{}{
			"answered":  answered,
			"dropped":   dropped,
			"ts":        strconv.FormatInt(e.ReceivedAt.UnixMilli(), 10),
			"call_uuid": e.CallUUID,
		},
	})
}
