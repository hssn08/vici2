package esl

import (
	"context"
	"strconv"
	"time"

	"github.com/percipia/eslgo"
	"github.com/redis/go-redis/v9"
)

// EnrichedEvent wraps a raw eslgo.Event with correlation IDs hydrated from
// channel vars and, when vars are missing, from the Valkey in_flight HASH.
// See T01 PLAN §10.1.
type EnrichedEvent struct {
	*eslgo.Event
	FSHost     string
	TenantID   int64
	LeadID     int64
	AgentID    int64
	CampaignID int64
	CallUUID   string
	ReceivedAt time.Time
	// Critical events must never be dropped on backpressure (PLAN §10.4).
	Critical bool
}

// criticalEvents is the set of event names that must never be dropped.
var criticalEvents = map[string]bool{
	"CHANNEL_HANGUP_COMPLETE": true,
	"CHANNEL_BRIDGE":          true,
	"RECORD_STOP":             true,
	"BACKGROUND_JOB":          true,
}

// enrichEvent builds an EnrichedEvent from a raw eslgo.Event.
// It first reads variable_* headers; for any missing IDs it falls back
// to the Valkey in_flight HASH (PLAN §11.3).
//
// The redis.Cmdable argument may be nil (e.g. in tests without Valkey);
// in that case hydration is skipped and IDs may be zero.
func enrichEvent(
	ctx context.Context,
	ev *eslgo.Event,
	fsHost string,
	rdb redis.Cmdable,
	tenantID int64,
	m *eslMetrics,
) EnrichedEvent {
	name := ev.GetName()

	// Determine conference::maintenance criticality
	critical := criticalEvents[name]
	if name == "CUSTOM" {
		sub := ev.GetHeader("Event-Subclass")
		if sub == "conference::maintenance" {
			action := ev.GetHeader("Action")
			if action == "del-member" || action == "conference-destroy" {
				critical = true
			}
		}
	}

	e := EnrichedEvent{
		Event:      ev,
		FSHost:     fsHost,
		TenantID:   tenantID,
		CallUUID:   ev.GetHeader("Unique-Id"),
		ReceivedAt: time.Now(),
		Critical:   critical,
	}

	// Parse channel vars from headers.
	e.LeadID = parseInt64Header(ev, "variable_lead_id")
	e.AgentID = parseInt64Header(ev, "variable_agent_id")
	e.CampaignID = parseInt64Header(ev, "variable_campaign_id")
	if tid := parseInt64Header(ev, "variable_tenant_id"); tid > 0 {
		e.TenantID = tid
	}

	// Hydrate missing IDs from Valkey if we have a UUID.
	if rdb != nil && e.CallUUID != "" && (e.LeadID == 0 || e.AgentID == 0 || e.CampaignID == 0) {
		key := inFlightKey(e.TenantID, e.CallUUID)
		vals, err := rdb.HMGet(ctx, key, "lead_id", "agent_id", "campaign_id", "tenant_id").Result()
		if err == nil {
			result := "ok"
			if e.LeadID == 0 {
				e.LeadID = parseValkeyInt64(vals[0])
			}
			if e.AgentID == 0 {
				e.AgentID = parseValkeyInt64(vals[1])
			}
			if e.CampaignID == 0 {
				e.CampaignID = parseValkeyInt64(vals[2])
			}
			if e.TenantID == 0 || e.TenantID == 1 {
				if tid := parseValkeyInt64(vals[3]); tid > 0 {
					e.TenantID = tid
				}
			}
			// Determine hydration outcome for metrics.
			if e.LeadID == 0 || e.AgentID == 0 {
				result = "partial"
			}
			if vals[0] == nil && vals[1] == nil && vals[2] == nil {
				result = "miss"
			}
			if m != nil {
				m.eventHydrationTotal.WithLabelValues(result).Inc()
			}
		}
	}

	return e
}

// inFlightKey builds the t:{tid}:in_flight:{uuid} key per F04 HANDOFF §4.8.
func inFlightKey(tenantID int64, callUUID string) string {
	return "t:" + strconv.FormatInt(tenantID, 10) + ":in_flight:{" + callUUID + "}"
}

func parseInt64Header(ev *eslgo.Event, header string) int64 {
	s := ev.GetHeader(header)
	if s == "" {
		return 0
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func parseValkeyInt64(v interface{}) int64 {
	if v == nil {
		return 0
	}
	s, ok := v.(string)
	if !ok {
		return 0
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
