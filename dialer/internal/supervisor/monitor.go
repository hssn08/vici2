// Package supervisor implements the S02 live-monitor (eavesdrop/whisper/barge)
// primitives for the dialer.
//
// Single-conference model (S02 PLAN §2): the supervisor joins the existing
// agent_t<tid>_u<uid>@default conference with mode-specific flags. No second
// conference, no uuid_bridge.
//
// The three modes are:
//   - Eavesdrop: supervisor joins with `mute` flag; hears all, heard by none.
//   - Whisper:   supervisor joins WITHOUT mute; `relate nospeak` prevents
//                supervisor audio reaching customer. Agent hears supervisor.
//   - Barge:     supervisor joins without mute and without relate; 3-way
//                conversation.
//
// S02 PLAN §3, §4.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/conference"
	"github.com/vici2/dialer/internal/esl"
	vk "github.com/vici2/dialer/internal/valkey"
)

// Mode represents the supervisor's monitoring mode.
type Mode string

const (
	// ModeEavesdrop: supervisor joins with `mute` flag. Hears all; heard by nobody.
	ModeEavesdrop Mode = "listen"
	// ModeWhisper: supervisor joins unmuted; `relate nospeak` applied against
	// every non-agent member. Heard only by agent.
	ModeWhisper Mode = "whisper"
	// ModeBarge: supervisor joins unmuted without any relate. Full 3-way.
	ModeBarge Mode = "barge"
)

// ParseMode parses a mode string (from URL, JWT, etc.) into a typed Mode.
// Returns ErrInvalidMode if the string is not a recognised mode.
func ParseMode(s string) (Mode, error) {
	switch Mode(s) {
	case ModeEavesdrop, ModeWhisper, ModeBarge:
		return Mode(s), nil
	}
	return "", ErrInvalidMode
}

// Session holds the live state of a single supervisor monitor session.
// It is populated by the conf-maint add-member handler and kept in Valkey.
type Session struct {
	// JTI is the grant-token jti; also used as the session identifier
	// surfaced to the API.
	JTI string

	// SupCallUUID is the supervisor's FS channel UUID (assigned by FS when
	// the supervisor places the SIP INVITE).
	SupCallUUID string

	TenantID   int64
	TargetUID  int64 // agent being monitored
	SupUID     int64 // supervisor user id
	Mode       Mode
	ConfName   string // e.g. "agent_t1_u1042"
	MemberID   int    // supervisor's conference member-id
	StartedAt  time.Time
}

// Operator provides the supervisor monitor operations: join-time relate
// enumeration, mode transitions, and Valkey state management.
//
// Callers obtain an Operator via New and keep it for the lifetime of the
// process (it is goroutine-safe).
type Operator struct {
	esl    *esl.Client
	rdb    *vk.Client
	log    *slog.Logger
	fsHost string
}

// New creates an Operator. fsHost may be empty (round-robin).
func New(eslClient *esl.Client, rdb *vk.Client, fsHost string, log *slog.Logger) *Operator {
	if log == nil {
		log = slog.Default()
	}
	return &Operator{esl: eslClient, rdb: rdb, log: log, fsHost: fsHost}
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle (called from conf-maint handler on add-member /
// del-member events where vici2_role == "supervisor_leg").
// ─────────────────────────────────────────────────────────────────────────────

// OnSupervisorJoin is invoked by the T03 conf-maint handler when a new
// conference member with vici2_role="supervisor_leg" joins.
//
// It:
//  1. Writes session state to Valkey.
//  2. Publishes monitor.session.started to the events stream.
//  3. Issues relate nospeak against all non-agent members if mode == whisper.
//
// S02 PLAN §5.4.
func (o *Operator) OnSupervisorJoin(ctx context.Context, s Session) error {
	confName := conference.ConferenceName(s.TenantID, s.TargetUID)
	s.ConfName = confName

	// 1. Write session HASH to Valkey.
	if err := o.writeSessionHash(ctx, s); err != nil {
		return fmt.Errorf("supervisor OnSupervisorJoin: write session hash: %w", err)
	}

	// 2. Add to the supervisor ZSET for the target agent.
	monitorZKey := o.rdb.Keys.AgentMonitors(s.TenantID, s.TargetUID)
	score := float64(s.StartedAt.UnixMilli())
	if err := o.rdb.State.ZAdd(ctx, monitorZKey, redis.Z{Score: score, Member: s.SupCallUUID}).Err(); err != nil {
		return fmt.Errorf("supervisor OnSupervisorJoin: ZADD monitors: %w", err)
	}

	// 3. Add to conf_members HASH with supervisor role tag.
	confMembersKey := o.rdb.Keys.Agent(s.TargetUID) + ":conf_members"
	val := fmt.Sprintf("%d:supervisor_leg:%s", s.MemberID, string(s.Mode))
	if err := o.rdb.State.HSet(ctx, confMembersKey, s.SupCallUUID, val).Err(); err != nil {
		return fmt.Errorf("supervisor OnSupervisorJoin: HSET conf_members: %w", err)
	}

	// 4. If whisper mode, issue relate nospeak for every non-agent member.
	if s.Mode == ModeWhisper {
		if err := o.applyWhisperRelate(ctx, s, confName); err != nil {
			// Non-fatal: log and continue; the supervisor join should not
			// be rolled back just because relate fails.
			o.log.Warn("supervisor OnSupervisorJoin: applyWhisperRelate partial failure",
				slog.String("sup_uuid", s.SupCallUUID),
				slog.Any("err", err),
			)
		}
	}

	o.log.Info("supervisor session started",
		slog.String("sup_uuid", s.SupCallUUID),
		slog.Int64("target_uid", s.TargetUID),
		slog.String("mode", string(s.Mode)),
	)
	return nil
}

// OnSupervisorLeave is invoked by the T03 conf-maint handler when the
// supervisor's conference member is removed (either by API DELETE or
// spontaneous hang-up).
//
// It cleans up Valkey state. The api_hangup_hook fires separately to write
// the C03 audit row.
//
// S02 PLAN §5.4.
func (o *Operator) OnSupervisorLeave(ctx context.Context, tenantID, targetUID int64, supCallUUID string) error {
	// Remove from conf_members HASH.
	confMembersKey := o.rdb.Keys.Agent(targetUID) + ":conf_members"
	if err := o.rdb.State.HDel(ctx, confMembersKey, supCallUUID).Err(); err != nil {
		o.log.Warn("supervisor OnSupervisorLeave: HDel conf_members",
			slog.String("sup_uuid", supCallUUID), slog.Any("err", err))
	}

	// Remove from monitors ZSET.
	monitorZKey := o.rdb.Keys.AgentMonitors(tenantID, targetUID)
	if err := o.rdb.State.ZRem(ctx, monitorZKey, supCallUUID).Err(); err != nil {
		o.log.Warn("supervisor OnSupervisorLeave: ZREM monitors",
			slog.String("sup_uuid", supCallUUID), slog.Any("err", err))
	}

	// Delete session HASH.
	sessionKey := o.rdb.Keys.MonitorSession(tenantID, supCallUUID)
	if err := o.rdb.State.Del(ctx, sessionKey).Err(); err != nil {
		o.log.Warn("supervisor OnSupervisorLeave: DEL session",
			slog.String("sup_uuid", supCallUUID), slog.Any("err", err))
	}

	o.log.Info("supervisor session ended (valkey cleaned)",
		slog.String("sup_uuid", supCallUUID),
		slog.Int64("target_uid", targetUID),
	)
	return nil
}

// OnNewMemberJoined is called by the T03 conf-maint handler whenever a new
// non-agent, non-supervisor member joins (customer or third-party).
//
// It auto-issues `relate nospeak` for every active whisper supervisor so the
// new member cannot hear supervisors in whisper mode.
//
// S02 PLAN §5.4 (auto-relate for late-joining members).
func (o *Operator) OnNewMemberJoined(ctx context.Context, tenantID, targetUID int64, newMemberID int) error {
	monitorZKey := o.rdb.Keys.AgentMonitors(tenantID, targetUID)
	supUUIDs, err := o.rdb.State.ZRange(ctx, monitorZKey, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("supervisor OnNewMemberJoined: ZRANGE monitors: %w", err)
	}

	confName := conference.ConferenceName(tenantID, targetUID)

	for _, supUUID := range supUUIDs {
		sessionKey := o.rdb.Keys.MonitorSession(tenantID, supUUID)
		fields, err := o.rdb.State.HGetAll(ctx, sessionKey).Result()
		if err != nil || len(fields) == 0 {
			continue
		}
		if Mode(fields["mode"]) != ModeWhisper {
			continue
		}
		supMID, err := strconv.Atoi(fields["conf_member_id"])
		if err != nil {
			continue
		}
		relateArg := fmt.Sprintf("%d %d nospeak", supMID, newMemberID)
		if _, err := o.esl.ConferenceCommand(ctx, o.fsHost, confName, "relate", relateArg); err != nil {
			o.log.Warn("supervisor OnNewMemberJoined: relate nospeak failed",
				slog.String("sup_uuid", supUUID),
				slog.Int("new_mid", newMemberID),
				slog.Any("err", err),
			)
		}
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode transitions (S02 PLAN §4)
// ─────────────────────────────────────────────────────────────────────────────

// TransitionMode applies the zero-glitch mode transition from the session's
// current mode to newMode. Follows the strict ordering rules of S02 PLAN §4.2.
//
// Returns ErrSameMode if newMode == current mode.
func (o *Operator) TransitionMode(ctx context.Context, tenantID, targetUID int64, supCallUUID string, newMode Mode) error {
	sessionKey := o.rdb.Keys.MonitorSession(tenantID, supCallUUID)
	fields, err := o.rdb.State.HGetAll(ctx, sessionKey).Result()
	if err != nil {
		return fmt.Errorf("supervisor TransitionMode: HGETALL session: %w", err)
	}
	if len(fields) == 0 {
		return ErrSessionNotFound
	}

	currentMode := Mode(fields["mode"])
	if currentMode == newMode {
		return ErrSameMode
	}

	supMIDStr := fields["conf_member_id"]
	supMID, err := strconv.Atoi(supMIDStr)
	if err != nil {
		return fmt.Errorf("supervisor TransitionMode: parse sup member_id: %w", err)
	}
	confName := conference.ConferenceName(tenantID, targetUID)

	// Resolve non-agent, non-supervisor member IDs for relate calls.
	custMIDs, err := o.nonAgentNonSupMemberIDs(ctx, tenantID, targetUID)
	if err != nil {
		return fmt.Errorf("supervisor TransitionMode: resolve cust mids: %w", err)
	}

	seq, err := buildTransitionSequence(currentMode, newMode, supMID, custMIDs)
	if err != nil {
		return fmt.Errorf("supervisor TransitionMode: build sequence: %w", err)
	}

	// Execute the sequence in order (≤2 calls per transition per PLAN §4.1).
	for _, cmd := range seq {
		if _, err := o.esl.ConferenceCommand(ctx, o.fsHost, confName, cmd.command, cmd.args); err != nil {
			return fmt.Errorf("supervisor TransitionMode: conference %q %q: %w", cmd.command, cmd.args, err)
		}
	}

	// Update Valkey session mode.
	if err := o.rdb.State.HSet(ctx, sessionKey, "mode", string(newMode)).Err(); err != nil {
		return fmt.Errorf("supervisor TransitionMode: HSET session mode: %w", err)
	}
	// Update conf_members role tag to reflect new mode.
	confMembersKey := o.rdb.Keys.Agent(targetUID) + ":conf_members"
	newVal := fmt.Sprintf("%d:supervisor_leg:%s", supMID, string(newMode))
	if err := o.rdb.State.HSet(ctx, confMembersKey, supCallUUID, newVal).Err(); err != nil {
		o.log.Warn("supervisor TransitionMode: HSET conf_members mode tag failed", slog.Any("err", err))
	}

	o.log.Info("supervisor mode transitioned",
		slog.String("sup_uuid", supCallUUID),
		slog.String("from", string(currentMode)),
		slog.String("to", string(newMode)),
	)
	return nil
}

// GetSession reads a session from Valkey by (tenantID, supCallUUID).
// Returns ErrSessionNotFound if no session exists.
func (o *Operator) GetSession(ctx context.Context, tenantID int64, supCallUUID string) (*Session, error) {
	sessionKey := o.rdb.Keys.MonitorSession(tenantID, supCallUUID)
	fields, err := o.rdb.State.HGetAll(ctx, sessionKey).Result()
	if err != nil {
		return nil, fmt.Errorf("supervisor GetSession: HGETALL: %w", err)
	}
	if len(fields) == 0 {
		return nil, ErrSessionNotFound
	}
	return parseSessionFields(fields)
}

// KickSupervisor ejects the supervisor's member from the conference.
// The api_hangup_hook will fire asynchronously and write the audit row.
// OnSupervisorLeave will be called by the conf-maint del-member handler.
func (o *Operator) KickSupervisor(ctx context.Context, tenantID, targetUID int64, supCallUUID string) error {
	sessionKey := o.rdb.Keys.MonitorSession(tenantID, supCallUUID)
	fields, err := o.rdb.State.HGetAll(ctx, sessionKey).Result()
	if err != nil || len(fields) == 0 {
		return ErrSessionNotFound
	}
	supMID, err := strconv.Atoi(fields["conf_member_id"])
	if err != nil {
		return fmt.Errorf("supervisor KickSupervisor: parse member_id: %w", err)
	}
	confName := conference.ConferenceName(tenantID, targetUID)
	if _, err := o.esl.ConferenceCommand(ctx, o.fsHost, confName, "kick", strconv.Itoa(supMID)); err != nil {
		return fmt.Errorf("supervisor KickSupervisor: kick: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// applyWhisperRelate issues `relate <supMID> <custMID> nospeak` for every
// non-agent, non-supervisor member currently in the conference.
func (o *Operator) applyWhisperRelate(ctx context.Context, s Session, confName string) error {
	custMIDs, err := o.nonAgentNonSupMemberIDs(ctx, s.TenantID, s.TargetUID)
	if err != nil {
		return err
	}
	var errs []error
	for _, custMID := range custMIDs {
		relateArg := fmt.Sprintf("%d %d nospeak", s.MemberID, custMID)
		if _, err := o.esl.ConferenceCommand(ctx, o.fsHost, confName, "relate", relateArg); err != nil {
			errs = append(errs, fmt.Errorf("relate %d %d: %w", s.MemberID, custMID, err))
		}
	}
	return errors.Join(errs...)
}

// nonAgentNonSupMemberIDs reads conf_members from Valkey and returns member-ids
// for roles other than agent and supervisor.
func (o *Operator) nonAgentNonSupMemberIDs(ctx context.Context, tenantID, targetUID int64) ([]int, error) {
	confMembersKey := o.rdb.Keys.Agent(targetUID) + ":conf_members"
	entries, err := o.rdb.State.HGetAll(ctx, confMembersKey).Result()
	if err != nil {
		return nil, fmt.Errorf("HGETALL conf_members: %w", err)
	}
	var mids []int
	for _, val := range entries {
		parts := strings.Split(val, ":")
		if len(parts) < 2 {
			continue
		}
		role := parts[1]
		if role == "agent_leg" || role == "supervisor_leg" {
			continue
		}
		mid, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		mids = append(mids, mid)
	}
	return mids, nil
}

func (o *Operator) writeSessionHash(ctx context.Context, s Session) error {
	sessionKey := o.rdb.Keys.MonitorSession(s.TenantID, s.SupCallUUID)
	return o.rdb.State.HSet(ctx, sessionKey,
		"jti", s.JTI,
		"sup_call_uuid", s.SupCallUUID,
		"tid", strconv.FormatInt(s.TenantID, 10),
		"target_uid", strconv.FormatInt(s.TargetUID, 10),
		"sup_uid", strconv.FormatInt(s.SupUID, 10),
		"mode", string(s.Mode),
		"conf_name", s.ConfName,
		"conf_member_id", strconv.Itoa(s.MemberID),
		"started_at", strconv.FormatInt(s.StartedAt.UnixMilli(), 10),
	).Err()
}

func parseSessionFields(fields map[string]string) (*Session, error) {
	tid, _ := strconv.ParseInt(fields["tid"], 10, 64)
	targetUID, _ := strconv.ParseInt(fields["target_uid"], 10, 64)
	supUID, _ := strconv.ParseInt(fields["sup_uid"], 10, 64)
	mid, _ := strconv.Atoi(fields["conf_member_id"])
	startMs, _ := strconv.ParseInt(fields["started_at"], 10, 64)
	return &Session{
		JTI:         fields["jti"],
		SupCallUUID: fields["sup_call_uuid"],
		TenantID:    tid,
		TargetUID:   targetUID,
		SupUID:      supUID,
		Mode:        Mode(fields["mode"]),
		ConfName:    fields["conf_name"],
		MemberID:    mid,
		StartedAt:   time.UnixMilli(startMs),
	}, nil
}
