// scripts.go — embed Lua scripts at compile time, SCRIPT LOAD at boot,
// EVALSHA at call site with transparent NOSCRIPT reload.
//
// Sources of truth: shared/lua/*.v1.lua (copied into the dialer binary
// via go:embed at build time). The copy step is wired in the Makefile:
//   make valkey-sync-lua    # rsync shared/lua/*.lua into dialer/internal/valkey/lua/
// CI verifies the embedded copy matches shared/lua/ — see VERIFY.md.

package valkey

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/redis/go-redis/v9"
)

//go:embed lua/*.lua
var luaFS embed.FS

// ScriptName is the registry key for a Lua script.
type ScriptName string

const (
	ScriptClaimLeadFromHopper ScriptName = "claim_lead_from_hopper.v1"
	ScriptReleaseHopperLock   ScriptName = "release_hopper_lock.v1"
	ScriptRecordCallOutcome   ScriptName = "record_call_outcome.v1"
	ScriptPickAgentForCall    ScriptName = "pick_agent_for_call.v1"
	ScriptAgentStateTransition ScriptName = "agent_state_transition.v1"
	ScriptOriginateAcquire    ScriptName = "originate_acquire.v1"
	ScriptOriginateRelease    ScriptName = "originate_release.v1"
	ScriptDNCBloomCheck       ScriptName = "dnc_bloom_check.v1"
	ScriptRefreshConsume      ScriptName = "refresh_consume.v1"
)

// All script files we ship — must match files in shared/lua/.
var allScripts = []ScriptName{
	ScriptClaimLeadFromHopper,
	ScriptReleaseHopperLock,
	ScriptRecordCallOutcome,
	ScriptPickAgentForCall,
	ScriptAgentStateTransition,
	ScriptOriginateAcquire,
	ScriptOriginateRelease,
	ScriptDNCBloomCheck,
	ScriptRefreshConsume,
}

// ScriptRegistry holds compiled Lua sources + their SCRIPT LOAD SHAs.
// Safe for concurrent use after Load(). The mutex only guards in-flight
// re-loads (NOSCRIPT path); the steady-state read of SHAs is lock-free
// after Load via the immutable maps.
type ScriptRegistry struct {
	mu     sync.RWMutex
	source map[ScriptName]string
	sha    map[ScriptName]string
}

// NewScriptRegistry reads the embedded Lua sources into memory.
// It does NOT yet call SCRIPT LOAD — call Load(ctx, client) for that.
func NewScriptRegistry() (*ScriptRegistry, error) {
	r := &ScriptRegistry{
		source: make(map[ScriptName]string, len(allScripts)),
		sha:    make(map[ScriptName]string, len(allScripts)),
	}
	for _, name := range allScripts {
		body, err := luaFS.ReadFile("lua/" + string(name) + ".lua")
		if err != nil {
			return nil, fmt.Errorf("valkey: embedded lua %s missing: %w", name, err)
		}
		r.source[name] = string(body)
	}
	return r, nil
}

// Load issues SCRIPT LOAD for every script against `client` and caches
// the resulting SHA1 strings. Safe to call again at any time (e.g. after
// FLUSHALL or a server restart wiped the script cache).
func (r *ScriptRegistry) Load(ctx context.Context, client redis.Cmdable) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, body := range r.source {
		sha, err := client.ScriptLoad(ctx, body).Result()
		if err != nil {
			return fmt.Errorf("valkey: SCRIPT LOAD %s: %w", name, err)
		}
		r.sha[name] = sha
	}
	return nil
}

// SHA returns the SCRIPT LOAD SHA for `name`. Empty string if Load was
// not yet called or the script was never registered.
func (r *ScriptRegistry) SHA(name ScriptName) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sha[name]
}

// Source returns the literal Lua source for `name`.
func (r *ScriptRegistry) Source(name ScriptName) string {
	return r.source[name] // immutable after NewScriptRegistry
}

// Eval runs the named script via EVALSHA with transparent NOSCRIPT
// auto-reload-and-retry. The result is whatever go-redis decodes (often
// `interface{}` — caller does the type assertion).
func (r *ScriptRegistry) Eval(
	ctx context.Context,
	client redis.Cmdable,
	name ScriptName,
	keys []string,
	args ...any,
) (any, error) {
	sha := r.SHA(name)
	if sha == "" {
		if err := r.Load(ctx, client); err != nil {
			return nil, err
		}
		sha = r.SHA(name)
		if sha == "" {
			return nil, fmt.Errorf("valkey: script %s unknown after reload", name)
		}
	}

	res, err := client.EvalSha(ctx, sha, keys, args...).Result()
	if err == nil {
		return res, nil
	}
	// redis.Nil is the "script returned nil" sentinel — surface as
	// (nil, nil) so callers can check the result without branching on
	// an error string.
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	// NOSCRIPT: cache wiped. Reload and retry once.
	if isNoScript(err) {
		if loadErr := r.Load(ctx, client); loadErr != nil {
			return nil, fmt.Errorf("valkey: %s: NOSCRIPT reload failed: %w", name, loadErr)
		}
		sha = r.SHA(name)
		res, err = client.EvalSha(ctx, sha, keys, args...).Result()
		if err == nil {
			return res, nil
		}
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
	}
	return nil, fmt.Errorf("valkey: EVALSHA %s: %w", name, err)
}

func isNoScript(err error) bool {
	if err == nil {
		return false
	}
	// go-redis returns the raw error string starting with "NOSCRIPT".
	var rErr interface{ Error() string }
	if errors.As(err, &rErr) {
		return strings.HasPrefix(rErr.Error(), "NOSCRIPT")
	}
	return false
}
