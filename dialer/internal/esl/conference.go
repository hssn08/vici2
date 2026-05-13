package esl

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ConferenceMember represents one member in a conference.
// T01 PLAN §8.1.
type ConferenceMember struct {
	MemberID   string
	UUID       string
	CallerNum  string
	CallerName string
	JoinedAt   time.Time
	Flags      []string // "mute", "deaf", "floor", etc.
}

// ConferenceCommand runs `conference <name> <command> <args...>`.
// Returns the parsed reply body (JSON for `list`, `+OK` for actions).
//
// T01 PLAN §8.
func (c *Client) ConferenceCommand(ctx context.Context, fsHost, conferenceName, command, args string) (string, error) {
	if c.isShuttingDown() {
		return "", ErrShuttingDown
	}
	start := time.Now()

	cmd := fmt.Sprintf("conference %s %s", conferenceName, command)
	if args != "" {
		cmd += " " + args
	}

	reply, err := c.command(ctx, fsHost, cmd)
	latency := time.Since(start)

	outcome := "ok"
	if err != nil {
		outcome = "error"
		c.metrics.commandTotal.WithLabelValues(fsHost, "conference", outcome).Inc()
		c.metrics.commandLatency.WithLabelValues(fsHost, "conference").Observe(latency.Seconds())
		return "", fmt.Errorf("esl ConferenceCommand: %w", err)
	}
	c.metrics.commandTotal.WithLabelValues(fsHost, "conference", outcome).Inc()
	c.metrics.commandLatency.WithLabelValues(fsHost, "conference").Observe(latency.Seconds())
	return reply, nil
}

// ConferenceList returns the current members of a conference.
// T01 PLAN §8.1.
func (c *Client) ConferenceList(ctx context.Context, fsHost, conferenceName string) ([]ConferenceMember, error) {
	reply, err := c.ConferenceCommand(ctx, fsHost, conferenceName, "json_list", "")
	if err != nil {
		return nil, err
	}
	return parseConferenceList(reply)
}

// ConferenceKick removes a member from a conference.
// T01 PLAN §8.1.
func (c *Client) ConferenceKick(ctx context.Context, fsHost, conferenceName, memberID string) error {
	_, err := c.ConferenceCommand(ctx, fsHost, conferenceName, "kick", memberID)
	return err
}

// ConferenceMute mutes or unmutes a conference member.
// T01 PLAN §8.1.
func (c *Client) ConferenceMute(ctx context.Context, fsHost, conferenceName, memberID string, mute bool) error {
	cmd := "unmute"
	if mute {
		cmd = "mute"
	}
	_, err := c.ConferenceCommand(ctx, fsHost, conferenceName, cmd, memberID)
	return err
}

// ConferenceHold puts a conference member on hold or releases from hold.
// T01 PLAN §8.1.
func (c *Client) ConferenceHold(ctx context.Context, fsHost, conferenceName, memberID string, hold bool) error {
	cmd := "unhold"
	if hold {
		cmd = "hold"
	}
	_, err := c.ConferenceCommand(ctx, fsHost, conferenceName, cmd, memberID)
	return err
}

// ConferenceSummary represents one conference in the all-conferences list.
// E06 PLAN §8.2.
type ConferenceSummary struct {
	Name        string
	MemberCount int
}

// ListAllConferences returns all active conferences on an FS host.
// Uses `api conference json_list` (no conference name = list all).
// E06 PLAN §8.2.
func (c *Client) ListAllConferences(ctx context.Context, fsHost string) ([]ConferenceSummary, error) {
	if c.isShuttingDown() {
		return nil, ErrShuttingDown
	}
	reply, err := c.command(ctx, fsHost, "conference json_list")
	if err != nil {
		return nil, fmt.Errorf("esl ListAllConferences: %w", err)
	}
	return parseAllConferences(reply)
}

// parseAllConferences parses the JSON array returned by `conference json_list`.
// FS returns a JSON array of conference objects when invoked without a name.
func parseAllConferences(reply string) ([]ConferenceSummary, error) {
	reply = strings.TrimSpace(reply)
	if reply == "" || reply == "+OK" || !strings.HasPrefix(reply, "[") {
		return nil, nil
	}
	var raw []struct {
		Name    string        `json:"conference_name"`
		Members []interface{} `json:"members"`
	}
	if err := json.Unmarshal([]byte(reply), &raw); err != nil {
		return nil, fmt.Errorf("parseAllConferences: %w", err)
	}
	out := make([]ConferenceSummary, 0, len(raw))
	for _, r := range raw {
		out = append(out, ConferenceSummary{
			Name:        r.Name,
			MemberCount: len(r.Members),
		})
	}
	return out, nil
}

// parseConferenceList parses the JSON output of `conference <name> json_list`.
// FreeSWITCH returns JSON with member fields. Handles both array and object forms.
func parseConferenceList(reply string) ([]ConferenceMember, error) {
	reply = strings.TrimSpace(reply)
	if reply == "" || reply == "+OK" || reply == "-ERR Conference not found" {
		return nil, nil
	}

	// FreeSWITCH json_list format:
	// {"conference_name":"...","members":[{"id":"1","uuid":"...","caller_num":"...","caller_name":"...","flags":"mute|deaf"},...]}
	var raw struct {
		Members []struct {
			ID         string `json:"id"`
			UUID       string `json:"uuid"`
			CallerNum  string `json:"caller_num"`
			CallerName string `json:"caller_name"`
			Flags      string `json:"flags"`
		} `json:"members"`
	}
	if err := json.Unmarshal([]byte(reply), &raw); err != nil {
		return nil, fmt.Errorf("parseConferenceList: %w", err)
	}

	members := make([]ConferenceMember, 0, len(raw.Members))
	for _, m := range raw.Members {
		var flags []string
		if m.Flags != "" {
			flags = strings.Split(m.Flags, "|")
		}
		members = append(members, ConferenceMember{
			MemberID:   m.ID,
			UUID:       m.UUID,
			CallerNum:  m.CallerNum,
			CallerName: m.CallerName,
			Flags:      flags,
		})
	}
	return members, nil
}
