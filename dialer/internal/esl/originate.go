package esl

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/percipia/eslgo/command"
)

// OnAnswerAction is the typed value of execute_on_answer.
// Implementations marshal themselves to the channel-var string.
// See T01 PLAN §7.1.
type OnAnswerAction interface{ asExecuteOnAnswer() string }

// OnAnswerPark parks the channel on answer (default).
type OnAnswerPark struct{}

func (OnAnswerPark) asExecuteOnAnswer() string { return "park" }

// OnAnswerConference transfers the customer leg into an agent conference.
type OnAnswerConference struct{ Name string } // e.g. "agent_t1_u7"

func (a OnAnswerConference) asExecuteOnAnswer() string {
	return fmt.Sprintf("transfer:%s XML default", a.Name)
}

// OnAnswerBridge bridges the channel to a dialstring endpoint.
type OnAnswerBridge struct{ Endpoint string }

func (a OnAnswerBridge) asExecuteOnAnswer() string {
	return fmt.Sprintf("bridge:%s", a.Endpoint)
}

// OnAnswerConferenceJoinOnly transfers the answered leg into a conference with
// +flags{join-only}, causing the transfer to fail-closed if the conference
// does not exist (agent logged out). Used by T03 for 3rd-party origination.
//
// FQN is the fully-qualified conference name, e.g. "agent_t1_u1042@default".
// T03 PLAN §8.4.
type OnAnswerConferenceJoinOnly struct{ FQN string }

func (a OnAnswerConferenceJoinOnly) asExecuteOnAnswer() string {
	return fmt.Sprintf("transfer:conference:%s+flags{join-only} inline default", a.FQN)
}

// OnAnswerCustom allows arbitrary execute_on_answer strings (e.g. eavesdrop).
type OnAnswerCustom struct{ Raw string }

func (a OnAnswerCustom) asExecuteOnAnswer() string { return a.Raw }

// OriginateRequest is the typed input to Client.Originate.
// See T01 PLAN §7.1.
type OriginateRequest struct {
	// Routing
	FSHost      string // target FS; "" = round-robin healthy
	GatewayName string // sofia gateway, e.g. "twilio_main"

	// Destination
	DestNumber     string // E.164
	CallerIDNumber string // E.164
	CallerIDName   string

	// Behaviour
	OriginateTimeout int          // ring time, seconds; default 30
	OnAnswer         OnAnswerAction
	ChannelVars      map[string]string // additional channel vars

	// Correlation
	LeadID     int64
	AgentID    int64
	CampaignID int64
	TenantID   int64

	// Pre-supplied UUIDs (if empty, generated)
	PreSuppliedUUID  string // origination_uuid / channel UUID
	PreSuppliedJobID string // Job-UUID / bgapi correlation
}

// Originate issues `bgapi originate` over ESL with a pre-supplied Job-UUID
// and origination_uuid, then waits for the BACKGROUND_JOB result.
//
// Returns the channel UUID (origination_uuid) immediately after the
// BACKGROUND_JOB arrives. Returns a typed error if circuit-open, rate-limited,
// FS dead, or the job times out.
//
// T01 PLAN §7.2.
func (c *Client) Originate(ctx context.Context, req OriginateRequest) (string, error) {
	if c.isShuttingDown() {
		return "", ErrShuttingDown
	}

	// Resolve FS host.
	fsHost, fc, err := c.resolveHost(req.FSHost)
	if err != nil {
		return "", err
	}

	// Circuit breaker check.
	if !fc.breaker.Allow() {
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "circuit_open").Inc()
		c.metrics.rateLimitBlockedTotal.WithLabelValues(fsHost, req.GatewayName, "circuit_open").Inc()
		return "", ErrCircuitOpen
	}

	// Ensure UUIDs.
	if req.PreSuppliedUUID == "" {
		req.PreSuppliedUUID = uuid.New().String()
	}
	if req.PreSuppliedJobID == "" {
		req.PreSuppliedJobID = uuid.New().String()
	}
	if req.TenantID == 0 {
		req.TenantID = c.opts.TenantID
	}
	if req.OriginateTimeout == 0 {
		req.OriginateTimeout = 30
	}
	if req.OnAnswer == nil {
		req.OnAnswer = OnAnswerPark{}
	}
	if req.FSHost == "" {
		c.metrics.unaffinedOrigTotal.Inc()
	}

	// Get the eslgo.Conn.
	conn, _, err := c.getConn(fsHost)
	if err != nil {
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "fs_dead").Inc()
		return "", err
	}

	// Build channel vars blob.
	vars := buildChannelVars(req)

	// Assemble the bgapi originate command string.
	// Wire shape per PLAN §7.3:
	//   bgapi originate {vars}sofia/gateway/{gw}/{dest} &park()
	// followed by Job-UUID header.
	dest := fmt.Sprintf("sofia/gateway/%s/%s", req.GatewayName, req.DestNumber)
	app := "&park()"
	bgCmd := fmt.Sprintf("bgapi originate %ssofía/gateway/%s/%s %s",
		vars, req.GatewayName, req.DestNumber, app)
	// Rebuild properly.
	bgCmd = fmt.Sprintf("bgapi originate %s%s %s", vars, dest, app)

	// Register Job-UUID callback before sending (race-free).
	jobCh := fc.jobs.register(req.PreSuppliedJobID)

	// Record start time for latency metric.
	start := time.Now()

	// Send bgapi with Job-UUID header.
	// eslgo's command.API builds the body; we need a custom command that also
	// sends the Job-UUID header. We build this as a raw SendCommand.
	rawCmd := &bgapiWithJobUUID{
		cmd:     bgCmd,
		jobUUID: req.PreSuppliedJobID,
	}
	resp, err := conn.SendCommand(ctx, rawCmd)
	if err != nil {
		fc.jobs.cancel(req.PreSuppliedJobID)
		fc.breaker.RecordFailure()
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "gateway_failure").Inc()
		return "", fmt.Errorf("originate: send bgapi: %w", err)
	}
	if !resp.IsOk() {
		fc.jobs.cancel(req.PreSuppliedJobID)
		fc.breaker.RecordFailure()
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "gateway_failure").Inc()
		return "", fmt.Errorf("originate: bgapi rejected: %s", resp.GetReply())
	}

	// Wait for BACKGROUND_JOB result.
	result, err := fc.jobs.await(req.PreSuppliedJobID, jobCh, c.opts.BgJobTimeout)
	latency := time.Since(start)

	if err != nil {
		// Timeout.
		c.metrics.jobsOrphanedTotal.WithLabelValues(fsHost).Inc()
		c.metrics.originateLatency.WithLabelValues(fsHost, "timeout").Observe(latency.Seconds())
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "timeout").Inc()
		fc.breaker.RecordFailure()
		return "", ErrJobOrphaned
	}

	if result.IsError {
		// FS returned -ERR.
		fc.breaker.RecordFailure()
		c.metrics.originateLatency.WithLabelValues(fsHost, "gateway_failure").Observe(latency.Seconds())
		c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "gateway_failure").Inc()
		return "", fmt.Errorf("originate: fs error: %s", result.Body)
	}

	// Success.
	fc.breaker.RecordSuccess()
	c.metrics.originateLatency.WithLabelValues(fsHost, "success").Observe(latency.Seconds())
	c.metrics.originateTotal.WithLabelValues(fsHost, req.GatewayName, "success").Inc()

	return req.PreSuppliedUUID, nil
}

// bgapiWithJobUUID is a custom eslgo command that sends bgapi + Job-UUID header.
// eslgo's SendCommand serialises the result of BuildMessage() and appends
// "Job-UUID: <value>\r\n" via the header mechanism.
type bgapiWithJobUUID struct {
	cmd     string
	jobUUID string
}

// BuildMessage returns the raw ESL wire frame body for the bgapi command.
// We include Job-UUID as part of the ESL command framing.
// The eslgo library sends: "<cmd>\r\nJob-UUID: <uuid>\r\n\r\n"
func (b *bgapiWithJobUUID) BuildMessage() string {
	return b.cmd + "\r\nJob-UUID: " + b.jobUUID
}

// buildChannelVars assembles the {var=val,...} prefix for the originate command.
// Order: fixed correlation vars, then caller-id, then timeout, then on-answer,
// then caller-supplied extras.
func buildChannelVars(req OriginateRequest) string {
	vars := make([]string, 0, 20)
	add := func(k, v string) {
		if v != "" {
			vars = append(vars, k+"="+v)
		}
	}

	// Pre-supplied UUID (so we know the channel UUID before CHANNEL_CREATE).
	add("origination_uuid", req.PreSuppliedUUID)

	// Caller ID.
	add("origination_caller_id_number", req.CallerIDNumber)
	add("origination_caller_id_name", req.CallerIDName)

	// Timeouts.
	if req.OriginateTimeout > 0 {
		add("originate_timeout", fmt.Sprintf("%d", req.OriginateTimeout))
		add("call_timeout", fmt.Sprintf("%d", req.OriginateTimeout))
	}

	// Bridge/hangup behaviour.
	vars = append(vars, "hangup_after_bridge=true")
	vars = append(vars, "ignore_early_media=true")

	// Correlation IDs (round-trip on every CHANNEL_* event header).
	if req.LeadID != 0 {
		add("lead_id", fmt.Sprintf("%d", req.LeadID))
	}
	if req.AgentID != 0 {
		add("agent_id", fmt.Sprintf("%d", req.AgentID))
	}
	if req.CampaignID != 0 {
		add("campaign_id", fmt.Sprintf("%d", req.CampaignID))
	}
	if req.TenantID != 0 {
		add("tenant_id", fmt.Sprintf("%d", req.TenantID))
	}

	// SIP X-headers for carrier correlation.
	if req.LeadID != 0 {
		add("sip_h_X-Vici2-Lead", fmt.Sprintf("%d", req.LeadID))
	}
	if req.CampaignID != 0 {
		add("sip_h_X-Vici2-Campaign", fmt.Sprintf("%d", req.CampaignID))
	}

	// On-answer action.
	if req.OnAnswer != nil {
		add("execute_on_answer", req.OnAnswer.asExecuteOnAnswer())
	}

	// Caller-supplied extras (may override any of the above if needed).
	for k, v := range req.ChannelVars {
		if v != "" {
			vars = append(vars, k+"="+v)
		}
	}

	if len(vars) == 0 {
		return ""
	}
	return "{" + strings.Join(vars, ",") + "}"
}

// resolveHost returns the FS host to use for a command.
// If fsHost is empty, round-robins across healthy hosts.
func (c *Client) resolveHost(fsHost string) (string, *fsConn, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if fsHost != "" {
		fc, ok := c.conns[fsHost]
		if !ok {
			return "", nil, ErrFSUnknown
		}
		if fc.isDead() {
			return fsHost, fc, ErrFSDead
		}
		return fsHost, fc, nil
	}

	// Round-robin across healthy (READY, not DEAD, breaker not OPEN) hosts.
	c.rrMu.Lock()
	defer c.rrMu.Unlock()

	hosts := make([]string, 0, len(c.conns))
	for h := range c.conns {
		hosts = append(hosts, h)
	}

	for i := 0; i < len(hosts); i++ {
		idx := int(c.rrIdx) % len(hosts)
		c.rrIdx++
		h := hosts[idx]
		fc := c.conns[h]
		if fc.isReady() && fc.breaker.Allow() {
			return h, fc, nil
		}
	}
	return "", nil, ErrAllFSDown
}

// command is a helper that sends a bgapi command and returns the reply body.
// Used by all non-originate command methods.
func (c *Client) command(ctx context.Context, fsHost, cmd string) (string, error) {
	conn, _, err := c.getConn(fsHost)
	if err != nil {
		return "", err
	}
	resp, err := conn.SendCommand(ctx, command.API{
		Command:    cmd,
		Background: false,
	})
	if err != nil {
		return "", err
	}
	return resp.GetReply(), nil
}

// bgCommand sends a bgapi command and returns immediately with the reply.
// The actual result is delivered asynchronously via BACKGROUND_JOB.
func (c *Client) bgCommand(ctx context.Context, fsHost, cmd string) (string, error) {
	conn, _, err := c.getConn(fsHost)
	if err != nil {
		return "", err
	}
	resp, err := conn.SendCommand(ctx, command.API{
		Command:    cmd,
		Background: true,
	})
	if err != nil {
		return "", err
	}
	return resp.GetReply(), nil
}
