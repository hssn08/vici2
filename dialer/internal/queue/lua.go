package queue

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

//go:embed scripts/dispatch_inbound.v1.lua
var dispatchLuaScript string

// luaScripts holds pre-loaded Lua SHA digests.
type luaScripts struct {
	dispatchSHA string
}

// loadScripts loads all Lua scripts via SCRIPT LOAD. Called at startup.
// I01 PLAN §19.1 + PLAN §22.3 (SHA mismatch: fail loud).
func loadScripts(ctx context.Context, rdb *redis.Client, log *slog.Logger) (*luaScripts, error) {
	sha, err := rdb.ScriptLoad(ctx, dispatchLuaScript).Result()
	if err != nil {
		return nil, fmt.Errorf("queue: SCRIPT LOAD dispatch_inbound.v1.lua: %w", err)
	}
	log.Info("queue: dispatch_inbound.v1.lua loaded", "sha", sha)
	return &luaScripts{dispatchSHA: sha}, nil
}

// EvalDispatch runs the atomic dispatch script.
// Returns (true, nil) on success.
// Returns (false, nil) with error text from Lua on CALL_NOT_IN_QUEUE / AGENT_NOT_READY.
// Returns (false, err) on Redis error.
// I01 PLAN §6.
func (s *luaScripts) EvalDispatch(
	ctx context.Context,
	rdb *redis.Client,
	keys [6]string,
	callUUID, userID string,
	nowMs int64,
	ingroupID string,
) (bool, error) {
	result, err := rdb.EvalSha(ctx, s.dispatchSHA, keys[:],
		callUUID,
		userID,
		nowMs,
		ingroupID,
	).Result()
	if err != nil {
		// Lua error replies come back as Go errors with "CALL_NOT_IN_QUEUE" or
		// "AGENT_NOT_READY" in the message — treat these as non-fatal races.
		if err.Error() == "CALL_NOT_IN_QUEUE" || err.Error() == "AGENT_NOT_READY" {
			return false, nil
		}
		return false, fmt.Errorf("queue: evalsha dispatch: %w", err)
	}
	_ = result
	return true, nil
}
