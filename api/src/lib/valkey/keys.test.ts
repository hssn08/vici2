// Unit tests for typed key builders. Run via `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Keys,
  ALL_AGENT_STATUSES,
  DNC_FEDERAL_BLOOM,
  DNC_LITIGATOR_BLOOM,
  eventStream,
} from "./keys.js";

test("key builders produce PLAN §4 strings", () => {
  const k = new Keys(1);
  assert.equal(k.agent(7), "t:1:agent:7");
  assert.equal(k.agentsByStatus("READY"), "t:1:agents:by_status:READY");
  assert.equal(
    k.agentsByCampaignStatus(42, "READY"),
    "t:1:agents:by_campaign:{42}:by_status:READY",
  );
  assert.equal(k.campaignHopper(42), "t:1:campaign:{42}:hopper");
  assert.equal(k.campaignInFlight(42), "t:1:campaign:{42}:in_flight");
  assert.equal(k.campaignDropWindow(42), "t:1:campaign:{42}:drop_window");
  assert.equal(k.campaignDialLevel(42), "t:1:campaign:{42}:dial_level");
  assert.equal(k.campaignActiveCalls(42), "t:1:campaign:{42}:active_calls");
  assert.equal(k.leadLockPrefix(42), "t:1:lead_lock:{42}:");
  assert.equal(k.leadLock(42, 12345), "t:1:lead_lock:{42}:12345");
  assert.equal(k.call("abc"), "t:1:call:abc");
  assert.equal(k.callActive(), "t:1:call:active");
  assert.equal(k.inFlightCall("abc"), "t:1:in_flight:{abc}");
  assert.equal(k.gatewayActive(7), "t:1:gw:7:active");
  assert.equal(k.dialerTick(42), "t:1:dialer:tick:42");
  assert.equal(k.janitorLock(), "t:1:janitor:lock");
  assert.equal(k.adaptLock(42), "t:1:adapt:lock:42");
  assert.equal(k.broadcastAgent(7), "t:1:broadcast:agent:7");
  assert.equal(k.broadcastCampaign(42), "t:1:broadcast:campaign:42");
  assert.equal(k.broadcastWallboard(), "t:1:broadcast:wallboard");
  assert.equal(k.dncCache("+14155551212"), "cache:dnc:1:+14155551212");
  assert.equal(k.dncInternalBloom(), "t:1:dnc:internal:bloom");
  assert.equal(k.dncStateBloom(), "t:1:dnc:state:bloom");
  assert.equal(DNC_FEDERAL_BLOOM, "bf:dnc:federal");
  assert.equal(DNC_LITIGATOR_BLOOM, "bf:dnc:litigator");
  assert.equal(k.dncBypassToken("abc"), "t:1:dnc:bypass:abc");
  assert.equal(k.authRefresh("fid", "thash"), "t:1:auth:refresh:fid:thash");
  assert.equal(k.authRefreshFamily("fid"), "t:1:auth:refresh:family:fid");
  assert.equal(k.authRefreshUser(7), "t:1:auth:refresh:user:7");
  assert.equal(eventStream("call", "answered"), "events:vici2.call.answered");
});

test("per-campaign keys all share the same {cid} hash tag", () => {
  const k = new Keys(1);
  const cid = 42;
  const tag = "{42}";
  for (const key of [
    k.campaignHopper(cid),
    k.campaignInFlight(cid),
    k.campaignDropWindow(cid),
    k.campaignDialLevel(cid),
    k.campaignActiveCalls(cid),
    k.leadLock(cid, 1),
    k.agentsByCampaignStatus(cid, "READY"),
  ]) {
    assert.ok(key.includes(tag), `${key} missing ${tag}`);
  }
});

test("Keys rejects invalid tenantId", () => {
  assert.throws(() => new Keys(0));
  assert.throws(() => new Keys(-1));
  assert.throws(() => new Keys(Number.NaN));
});

test("AgentStatus enum covers all six PLAN §4.6 values", () => {
  assert.equal(ALL_AGENT_STATUSES.length, 6);
  assert.ok(ALL_AGENT_STATUSES.includes("READY"));
  assert.ok(ALL_AGENT_STATUSES.includes("LOGOUT"));
});
