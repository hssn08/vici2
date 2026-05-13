// operator.go — T03 agent-conference operator.
//
// Operator is the per-dialer conference operator. One instance per dialer
// process; safe for concurrent use. Wraps the ESL Client (T01) and the
// Valkey Client (F04) to implement the full agent-conference lifecycle:
//
//   - EnsureAgentConfReady  — post-login observation
//   - TransferCustomer      — attach customer leg to agent conf
//   - TransferThirdParty    — 3-way call origination
//   - MuteMember / UnmuteMember / MuteCustomer — audio muting
//   - KickMember / KickCustomer — leg ejection
//   - HoldCustomer / ResumeCustomer — hold via separate parking conf
//   - LeaveThreeWay         — agent drops from 3-way, others stay
//   - DestroyAgentConf      — explicit logout teardown
//   - GetMembers            — member list (Valkey → ESL fallback)
//   - MemberIDForCall       — member-id resolution (Valkey → uuid_getvar)
//
// T03 PLAN §4.
package conference

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/esl"
	"github.com/vici2/dialer/internal/valkey"
)

const (
	// memberIDPollInterval is the brief wait between Valkey HGET attempts in
	// MemberIDForCall before falling back to uuid_getvar. PLAN §5.4.
	memberIDPollInterval = 100 * time.Millisecond

	// ensureConfTimeout is how long EnsureAgentConfReady retries before
	// giving up. PLAN §4.3 (worst-case add-member event delay = 7 s).
	ensureConfTimeout = 7 * time.Second
)

// Operator implements the T03 conference primitive surface.
type Operator struct {
	esl    *esl.Client
	rdb    *valkey.Client
	log    *slog.Logger
	fsHost string // affinity host; "" = round-robin
}

// New returns an Operator. fsHost may be empty (round-robin across healthy
// FS hosts). log may be nil (falls back to slog.Default()).
func New(eslClient *esl.Client, rdb *valkey.Client, fsHost string, log *slog.Logger) *Operator {
	if log == nil {
		log = slog.Default()
	}
	return &Operator{
		esl:    eslClient,
		rdb:    rdb,
		log:    log,
		fsHost: fsHost,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 Operations
// ─────────────────────────────────────────────────────────────────────────────

// EnsureAgentConfReady is the idempotent post-login observation.
// It does NOT create the conference; mod_conference auto-creates it when the
// agent's SIP leg joins via the dialplan. This method queries the ESL
// conference list and populates Valkey state, then returns the agent's
// member-id.
//
// Returns ErrAgentNotInConf if the agent cannot be found within the
// ensureConfTimeout window.
func (o *Operator) EnsureAgentConfReady(ctx context.Context, tenantID, userID int64) (memberID int, err error) {
	name := ConferenceName(tenantID, userID)
	deadline := time.Now().Add(ensureConfTimeout)

	for time.Now().Before(deadline) {
		members, listErr := o.esl.ConferenceList(ctx, o.fsHost, name)
		if listErr != nil {
			// Conference may not exist yet; keep retrying.
			o.log.Debug("conference list retry", slog.String("conf", name), slog.Any("err", listErr))
		} else {
			for _, m := range members {
				// The agent's leg has the "moderator" flag.
				for _, f := range m.Flags {
					if f == "moderator" {
						mid, parseErr := strconv.Atoi(m.MemberID)
						if parseErr != nil {
							return 0, fmt.Errorf("conference: bad member-id %q: %w", m.MemberID, parseErr)
						}
						// Populate Valkey: conf_name + conf_member_id on agent HASH.
						if rdbErr := o.setAgentConfFields(ctx, tenantID, userID, name, mid); rdbErr != nil {
							o.log.Warn("EnsureAgentConfReady: Valkey update failed",
								slog.Any("err", rdbErr))
						}
						return mid, nil
					}
				}
			}
		}

		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return 0, ErrAgentNotInConf
}

// TransferCustomer transfers a customer's call leg into the agent's conference.
// Pre-sets vici2_* channel-vars on the customer leg to ensure proper role
// tagging in conf-maint events (§5.3 handler). Uses +flags{join-only} to
// fail-closed when the conference doesn't exist.
//
// Returns the bgapi Job-UUID. The actual conf member-id arrives via the
// add-member event (conf-maint handler). For immediately needed member-ids
// use MemberIDForCall.
func (o *Operator) TransferCustomer(ctx context.Context, tenantID, userID int64, customerCallUUID string) (jobUUID string, err error) {
	// Set channel vars: role, correlation IDs, empty conference_member_flags
	// (overrides any default endconf so customer hangup does NOT collapse conf).
	vars := map[string]string{
		"vici2_role":              "customer_leg",
		"vici2_user_id":           strconv.FormatInt(userID, 10),
		"vici2_tenant_id":         strconv.FormatInt(tenantID, 10),
		"vici2_call_uuid":         customerCallUUID,
		"conference_member_flags": "",
	}
	if err := o.setVarsMulti(ctx, customerCallUUID, vars); err != nil {
		return "", fmt.Errorf("conference TransferCustomer: set vars: %w", err)
	}

	// Transfer into the agent's conference with join-only to fail-closed.
	dest := "conference:" + ConferenceFQN(tenantID, userID, "default") + "+flags{join-only}"
	if err := o.esl.UUIDTransfer(ctx, o.fsHost, customerCallUUID, dest, "inline", "default"); err != nil {
		return "", fmt.Errorf("conference TransferCustomer: uuid_transfer: %w", err)
	}
	// We don't have access to the Job-UUID from UUIDTransfer (it uses bgapi
	// internally but doesn't surface the job-uuid). Return a generated sentinel.
	return uuid.New().String(), nil
}

// TransferThirdParty originates a third leg directly into the agent's
// conference for a 3-way call. The third leg carries endconf so that if the
// agent later calls LeaveThreeWay, the conference survives with customer +
// third party bridged.
//
// Returns (originatedUUID, jobUUID, error). The originated UUID is
// pre-supplied so the caller can correlate without waiting for events.
func (o *Operator) TransferThirdParty(
	ctx context.Context,
	tenantID, userID int64,
	gateway, dest, cidName, cidNumber string,
) (originatedUUID, jobUUID string, err error) {
	originatedUUID = uuid.New().String()

	req := esl.OriginateRequest{
		FSHost:           o.fsHost,
		GatewayName:      gateway,
		DestNumber:       dest,
		CallerIDName:     cidName,
		CallerIDNumber:   cidNumber,
		OriginateTimeout: 30,
		PreSuppliedUUID:  originatedUUID,
		TenantID:         tenantID,
		// On-answer: join the agent conference directly (join-only for fail-close).
		OnAnswer: esl.OnAnswerConferenceJoinOnly{
			FQN: ConferenceFQN(tenantID, userID, "default"),
		},
		ChannelVars: map[string]string{
			"vici2_role":              "third_leg",
			"vici2_user_id":           strconv.FormatInt(userID, 10),
			"vici2_tenant_id":         strconv.FormatInt(tenantID, 10),
			"conference_member_flags": "endconf", // 3rd-party carries endconf for LeaveThreeWay
			"origination_caller_id_name":   cidName,
			"origination_caller_id_number": cidNumber,
		},
	}

	callUUID, err := o.esl.Originate(ctx, req)
	if err != nil {
		return "", "", fmt.Errorf("conference TransferThirdParty: originate: %w", err)
	}
	return callUUID, req.PreSuppliedJobID, nil
}

// MuteMember mutes a specific conference member by member-id.
func (o *Operator) MuteMember(ctx context.Context, tenantID, userID int64, memberID int) error {
	name := ConferenceName(tenantID, userID)
	_, err := o.esl.ConferenceCommand(ctx, o.fsHost, name, "mute", strconv.Itoa(memberID))
	if err != nil {
		return fmt.Errorf("conference MuteMember: %w", err)
	}
	return nil
}

// UnmuteMember reverses MuteMember.
func (o *Operator) UnmuteMember(ctx context.Context, tenantID, userID int64, memberID int) error {
	name := ConferenceName(tenantID, userID)
	_, err := o.esl.ConferenceCommand(ctx, o.fsHost, name, "unmute", strconv.Itoa(memberID))
	if err != nil {
		return fmt.Errorf("conference UnmuteMember: %w", err)
	}
	return nil
}

// MuteCustomer resolves the customer member-id from the conf_members HASH
// and mutes that member. Returns ErrCustomerNotInConf if no customer is present.
// Authorization (supervisor-only) is enforced at the API layer.
func (o *Operator) MuteCustomer(ctx context.Context, tenantID, userID int64) error {
	mid, _, err := o.resolveCustomerMember(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	return o.MuteMember(ctx, tenantID, userID, mid)
}

// KickMember ejects a specific conference member by member-id.
func (o *Operator) KickMember(ctx context.Context, tenantID, userID int64, memberID int) error {
	name := ConferenceName(tenantID, userID)
	_, err := o.esl.ConferenceCommand(ctx, o.fsHost, name, "kick", strconv.Itoa(memberID))
	if err != nil {
		return fmt.Errorf("conference KickMember: %w", err)
	}
	return nil
}

// KickCustomer ejects all non-moderator members from the agent's conference
// (customer + any 3rd parties). The agent (sole moderator) stays.
func (o *Operator) KickCustomer(ctx context.Context, tenantID, userID int64) error {
	name := ConferenceName(tenantID, userID)
	_, err := o.esl.ConferenceCommand(ctx, o.fsHost, name, "kick", "non_moderator")
	if err != nil {
		return fmt.Errorf("conference KickCustomer: %w", err)
	}
	return nil
}

// HoldCustomer moves the customer member to the parking conference with MOH
// (the "hold" profile). The customer hears MOH; the agent stays in the
// main conference. recording_follow_transfer on the customer leg preserves
// the contiguous recording across the move.
//
// Implementation: conference <src> transfer <dst> <memberID>
func (o *Operator) HoldCustomer(ctx context.Context, tenantID, userID int64) error {
	mid, callUUID, err := o.resolveCustomerMember(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	srcName := ConferenceName(tenantID, userID)
	dstFQN := HoldConferenceName(tenantID, userID) + "@hold"

	// conference <src> transfer <dst> <memberID>
	_, err = o.esl.ConferenceCommand(ctx, o.fsHost, srcName,
		fmt.Sprintf("transfer %s %d", dstFQN, mid), "")
	if err != nil {
		return fmt.Errorf("conference HoldCustomer: transfer: %w", err)
	}

	// Update Valkey hold state.
	o.setHoldState(ctx, tenantID, userID, callUUID, true)
	return nil
}

// ResumeCustomer reverses HoldCustomer — moves the customer back from the
// hold conference into the agent's main conference.
func (o *Operator) ResumeCustomer(ctx context.Context, tenantID, userID int64) error {
	mid, callUUID, err := o.resolveCustomerInHold(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	holdName := HoldConferenceName(tenantID, userID)
	dstName := ConferenceName(tenantID, userID)

	_, err = o.esl.ConferenceCommand(ctx, o.fsHost, holdName,
		fmt.Sprintf("transfer %s %d", dstName, mid), "")
	if err != nil {
		return fmt.Errorf("conference ResumeCustomer: transfer: %w", err)
	}

	o.setHoldState(ctx, tenantID, userID, callUUID, false)
	return nil
}

// LeaveThreeWay kicks the agent's own moderator member out of the conference,
// leaving customer + 3rd party bridged. The conference survives because the
// 3rd-party leg was originated with endconf (see TransferThirdParty).
func (o *Operator) LeaveThreeWay(ctx context.Context, tenantID, userID int64) error {
	// Resolve agent's member-id from Valkey.
	agentMID, err := o.agentMemberID(ctx, tenantID, userID)
	if err != nil {
		return fmt.Errorf("conference LeaveThreeWay: resolve agent mid: %w", err)
	}
	return o.KickMember(ctx, tenantID, userID, agentMID)
}

// DestroyAgentConf is the explicit logout teardown. Issues
// `conference <name> kick all` then a best-effort uuid_kill on the agent leg.
// Idempotent — returns nil if the conference doesn't exist.
func (o *Operator) DestroyAgentConf(ctx context.Context, tenantID, userID int64) error {
	name := ConferenceName(tenantID, userID)

	// Kick all members. Returns -ERR if conference not found; treat as success.
	reply, err := o.esl.ConferenceCommand(ctx, o.fsHost, name, "kick", "all")
	if err != nil {
		// "Conference not found" is not an error for this idempotent op.
		if isNotFound(reply) || isNotFound(err.Error()) {
			return nil
		}
		return fmt.Errorf("conference DestroyAgentConf: kick all: %w", err)
	}

	// Best-effort: also kill the agent's SIP leg UUID if we have it.
	agentUUID := o.getAgentLegUUID(ctx, tenantID, userID)
	if agentUUID != "" {
		_ = o.esl.UUIDKill(ctx, o.fsHost, agentUUID, "NORMAL_CLEARING")
	}
	return nil
}

// GetMembers returns all current members of the agent's conference.
// Reads from Valkey HASH first; falls back to `conference list` if empty.
func (o *Operator) GetMembers(ctx context.Context, tenantID, userID int64) ([]Member, error) {
	members, err := o.getMembersFromValkey(ctx, tenantID, userID)
	if err == nil && len(members) > 0 {
		return members, nil
	}

	// Fallback: query ESL directly.
	name := ConferenceName(tenantID, userID)
	eslMembers, err := o.esl.ConferenceList(ctx, o.fsHost, name)
	if err != nil {
		return nil, fmt.Errorf("conference GetMembers: esl list: %w", err)
	}

	result := make([]Member, 0, len(eslMembers))
	for _, m := range eslMembers {
		mid, _ := strconv.Atoi(m.MemberID)
		result = append(result, Member{
			MemberID:  mid,
			CallUUID:  m.UUID,
			CIDName:   m.CallerName,
			CIDNumber: m.CallerNum,
			Flags:     m.Flags,
			ConfName:  "default",
		})
	}
	return result, nil
}

// MemberIDForCall returns the member-id for a call leg currently in the
// agent's conference. Tries Valkey HASH first; falls back to uuid_getvar
// if the HASH miss persists beyond memberIDPollInterval. Returns
// ErrLegNotInConf if neither path produces a result.
func (o *Operator) MemberIDForCall(ctx context.Context, tenantID, userID int64, callUUID string) (int, error) {
	key := o.rdb.Keys.Agent(userID) + ":conf_members"

	// Attempt 1: immediate HGET.
	if mid, ok := o.getMemberIDFromHash(ctx, key, callUUID); ok {
		return mid, nil
	}

	// Wait briefly; covers typical event latency. PLAN §5.4.
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-time.After(memberIDPollInterval):
	}

	// Attempt 2: re-try HGET.
	if mid, ok := o.getMemberIDFromHash(ctx, key, callUUID); ok {
		return mid, nil
	}

	// Fallback: uuid_getvar conference_member_id (requires a live ESL client).
	if o.esl != nil {
		reply, getErr := o.esl.ConferenceCommand(ctx, o.fsHost,
			"", "uuid_getvar "+callUUID+" conference_member_id", "")
		if getErr == nil && reply != "" && reply != "-ERR" {
			mid, parseErr := strconv.Atoi(strings.TrimSpace(reply))
			if parseErr == nil {
				return mid, nil
			}
		}
	}

	return 0, ErrLegNotInConf
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

// setVarsMulti sets multiple channel variables via sequential UUIDSetVar calls.
// T01 does not yet expose UUIDSetVarMulti; this is the N-sequential fallback
// described in PLAN §2.4. A T01 amendment may add the multi-key form later.
func (o *Operator) setVarsMulti(ctx context.Context, callUUID string, vars map[string]string) error {
	for k, v := range vars {
		if err := o.esl.UUIDSetVar(ctx, o.fsHost, callUUID, k, v); err != nil {
			return fmt.Errorf("UUIDSetVar %s: %w", k, err)
		}
	}
	return nil
}

// setAgentConfFields writes conf_name and conf_member_id into the agent HASH.
func (o *Operator) setAgentConfFields(ctx context.Context, tenantID, userID int64, confName string, memberID int) error {
	key := o.rdb.Keys.Agent(userID)
	return o.rdb.State.HSet(ctx, key,
		"conf_name", confName,
		"conf_member_id", strconv.Itoa(memberID),
	).Err()
}

// agentMemberID returns the agent's conf_member_id from the Valkey HASH.
func (o *Operator) agentMemberID(ctx context.Context, tenantID, userID int64) (int, error) {
	key := o.rdb.Keys.Agent(userID)
	val, err := o.rdb.State.HGet(ctx, key, "conf_member_id").Result()
	if err != nil {
		if err == redis.Nil {
			return 0, ErrAgentNotInConf
		}
		return 0, fmt.Errorf("conference: agentMemberID HGET: %w", err)
	}
	mid, err := strconv.Atoi(val)
	if err != nil {
		return 0, fmt.Errorf("conference: agentMemberID parse: %w", err)
	}
	return mid, nil
}

// getAgentLegUUID returns the agent leg's call UUID from Valkey (field: call_uuid).
// Returns "" if not present — caller handles gracefully.
func (o *Operator) getAgentLegUUID(ctx context.Context, tenantID, userID int64) string {
	key := o.rdb.Keys.Agent(userID)
	val, err := o.rdb.State.HGet(ctx, key, "call_uuid").Result()
	if err != nil {
		return ""
	}
	return val
}

// resolveCustomerMember locates the customer member in the conf_members HASH.
// Returns (memberID, callUUID, error).
func (o *Operator) resolveCustomerMember(ctx context.Context, tenantID, userID int64) (int, string, error) {
	return o.resolveRoleMember(ctx, tenantID, userID, "customer_leg", "default")
}

// resolveCustomerInHold locates the customer member in the hold conf_members.
func (o *Operator) resolveCustomerInHold(ctx context.Context, tenantID, userID int64) (int, string, error) {
	return o.resolveRoleMember(ctx, tenantID, userID, "customer_leg", "hold")
}

// resolveRoleMember scans the conf_members HASH for a member with the given
// role and conf suffix. Value format: "<memberID>:<role>:<conf>" (PLAN §7.3).
func (o *Operator) resolveRoleMember(ctx context.Context, tenantID, userID int64, role, confSuffix string) (int, string, error) {
	key := o.rdb.Keys.Agent(userID) + ":conf_members"
	entries, err := o.rdb.State.HGetAll(ctx, key).Result()
	if err != nil {
		return 0, "", fmt.Errorf("conference: HGETALL conf_members: %w", err)
	}
	for callUUID, val := range entries {
		parts := strings.Split(val, ":")
		// Format: "<memberID>:<role>" or "<memberID>:<role>:<conf>"
		if len(parts) < 2 {
			continue
		}
		memberRole := parts[1]
		memberConf := "default"
		if len(parts) >= 3 {
			memberConf = parts[2]
		}
		if memberRole == role && memberConf == confSuffix {
			mid, err := strconv.Atoi(parts[0])
			if err != nil {
				continue
			}
			return mid, callUUID, nil
		}
	}
	return 0, "", ErrCustomerNotInConf
}

// getMembersFromValkey reads all conf_members from Valkey and returns typed Members.
func (o *Operator) getMembersFromValkey(ctx context.Context, tenantID, userID int64) ([]Member, error) {
	key := o.rdb.Keys.Agent(userID) + ":conf_members"
	entries, err := o.rdb.State.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	members := make([]Member, 0, len(entries))
	for callUUID, val := range entries {
		parts := strings.Split(val, ":")
		if len(parts) < 2 {
			continue
		}
		mid, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		confSuffix := "default"
		if len(parts) >= 3 {
			confSuffix = parts[2]
		}
		members = append(members, Member{
			MemberID: mid,
			CallUUID: callUUID,
			Role:     parseRole(parts[1]),
			ConfName: confSuffix,
		})
	}
	return members, nil
}

// getMemberIDFromHash reads a single member-id from the conf_members HASH.
func (o *Operator) getMemberIDFromHash(ctx context.Context, key, callUUID string) (int, bool) {
	val, err := o.rdb.State.HGet(ctx, key, callUUID).Result()
	if err != nil || val == "" {
		return 0, false
	}
	parts := strings.SplitN(val, ":", 2)
	mid, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, false
	}
	return mid, true
}

// setHoldState writes or clears the hold_state field in the agent HASH.
func (o *Operator) setHoldState(ctx context.Context, tenantID, userID int64, callUUID string, onHold bool) {
	key := o.rdb.Keys.Agent(userID)
	if onHold {
		_ = o.rdb.State.HSet(ctx, key,
			"hold_state", "ON",
			"hold_since", strconv.FormatInt(time.Now().UnixMilli(), 10),
			"hold_call_uuid", callUUID,
		).Err()
	} else {
		_ = o.rdb.State.HDel(ctx, key, "hold_state", "hold_since", "hold_call_uuid").Err()
	}
}

// isNotFound returns true if the reply or error message indicates a conference
// was not found (idempotency guard in DestroyAgentConf).
func isNotFound(s string) bool {
	return strings.Contains(s, "not found") || strings.Contains(s, "Conference not found")
}
