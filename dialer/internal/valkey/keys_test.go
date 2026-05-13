package valkey

import "testing"

func TestKeyBuilders(t *testing.T) {
	k := NewKeys(1)
	cases := []struct {
		got, want string
	}{
		{k.Agent(7), "t:1:agent:7"},
		{k.AgentsByStatus(AgentReady), "t:1:agents:by_status:READY"},
		{k.AgentsByCampaignStatus(42, AgentReady), "t:1:agents:by_campaign:{42}:by_status:READY"},
		{k.CampaignHopper(42), "t:1:campaign:{42}:hopper"},
		{k.CampaignInFlight(42), "t:1:campaign:{42}:in_flight"},
		{k.CampaignDropWindow(42), "t:1:campaign:{42}:drop_window"},
		{k.CampaignDialLevel(42), "t:1:campaign:{42}:dial_level"},
		{k.CampaignActiveCalls(42), "t:1:campaign:{42}:active_calls"},
		{k.LeadLockPrefix(42), "t:1:lead_lock:{42}:"},
		{k.LeadLock(42, 12345), "t:1:lead_lock:{42}:12345"},
		{k.Call("abc"), "t:1:call:abc"},
		{k.CallActive(), "t:1:call:active"},
		{k.InFlightCall("abc"), "t:1:in_flight:{abc}"},
		{k.GatewayActive(7), "t:1:gw:7:active"},
		{k.DialerTick(42), "t:1:dialer:tick:42"},
		{k.JanitorLock(), "t:1:janitor:lock"},
		{k.AdaptLock(42), "t:1:adapt:lock:42"},
		{k.BroadcastAgent(7), "t:1:broadcast:agent:7"},
		{k.BroadcastCampaign(42), "t:1:broadcast:campaign:42"},
		{k.BroadcastWallboard(), "t:1:broadcast:wallboard"},
		{k.DNCCache("+14155551212"), "cache:dnc:1:+14155551212"},
		{k.DNCInternalBloom(), "t:1:dnc:internal:bloom"},
		{k.DNCStateBloom(), "t:1:dnc:state:bloom"},
		{DNCFederalBloom(), "bf:dnc:federal"},
		{k.DNCBypassToken("abc"), "t:1:dnc:bypass:abc"},
		{k.AuthRefresh("fid", "thash"), "t:1:auth:refresh:fid:thash"},
		{k.AuthRefreshFamily("fid"), "t:1:auth:refresh:family:fid"},
		{k.AuthRefreshUser(7), "t:1:auth:refresh:user:7"},
		{EventStream("call", "answered"), "events:vici2.call.answered"},
		{k.AgentHashPrefix(), "t:1:agent:"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("key: got %q want %q", c.got, c.want)
		}
	}
}

func TestKeysHashTagsColocate(t *testing.T) {
	// The same {cid} hash tag must appear in every per-campaign key so
	// they colocate on a Cluster shard (PLAN §4.7).
	k := NewKeys(1)
	cid := int64(42)
	tag := "{42}"
	for _, key := range []string{
		k.CampaignHopper(cid),
		k.CampaignInFlight(cid),
		k.CampaignDropWindow(cid),
		k.CampaignDialLevel(cid),
		k.CampaignActiveCalls(cid),
		k.LeadLock(cid, 1),
		k.AgentsByCampaignStatus(cid, AgentReady),
	} {
		if !contains(key, tag) {
			t.Errorf("per-campaign key %q missing hash tag %q", key, tag)
		}
	}
}

// TestX04PoolKeys verifies X04 pool key format and hash-tag colocating.
func TestX04PoolKeys(t *testing.T) {
	k := NewKeys(1)
	poolID := int64(99)
	didID := int64(55)

	cases := []struct{ got, want string }{
		{k.PoolRRCursor(poolID), "t:1:pool:{99}:rr_cursor"},
		{k.PoolMembers(poolID), "t:1:pool:{99}:members"},
		{k.PoolInvalidate(poolID), "t:1:pool:{99}:invalidate"},
		{k.DIDDailyCalls(didID), "t:1:did:{55}:daily_calls"},
		{k.DIDConcurrent(didID), "t:1:did:{55}:concurrent"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("X04 key: got %q want %q", c.got, c.want)
		}
	}

	// All pool keys must share the same hash tag {99}
	tag := "{99}"
	for _, key := range []string{
		k.PoolRRCursor(poolID),
		k.PoolMembers(poolID),
		k.PoolInvalidate(poolID),
	} {
		if !contains(key, tag) {
			t.Errorf("pool key %q missing hash tag %q", key, tag)
		}
	}
}

// TestX05LocalPresenceKeys verifies X05 NPA index key format.
func TestX05LocalPresenceKeys(t *testing.T) {
	k := NewKeys(1)
	poolID := int64(7)
	didID := int64(1001)

	cases := []struct{ got, want string }{
		{k.PoolNPAIndex(poolID, "415"), "t:1:pool:{7}:npa:415"},
		{k.PoolStateIndex(poolID, "CA"), "t:1:pool:{7}:state:CA"},
		{k.PoolNPAIndexBuilt(poolID), "t:1:pool:{7}:npa_index_built"},
		{k.DIDQuarantined(poolID, didID), "t:1:pool:{7}:did:{1001}:quarantined"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("X05 key: got %q want %q", c.got, c.want)
		}
	}
}

func TestKeysPanicsOnBadTenant(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on tenant_id <= 0")
		}
	}()
	_ = NewKeys(0)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestScriptRegistryLoadsEmbeddedSource(t *testing.T) {
	r, err := NewScriptRegistry()
	if err != nil {
		t.Fatalf("NewScriptRegistry: %v", err)
	}
	for _, name := range allScripts {
		src := r.Source(name)
		if len(src) == 0 {
			t.Errorf("script %s: empty source", name)
		}
		// Sanity check: every Lua script we ship begins with a `--` comment
		// (per the convention in PLAN §6.6).
		if src[0] != '-' {
			t.Errorf("script %s: expected leading `--` comment, got %q", name, src[:1])
		}
	}
}
