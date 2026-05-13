// TS integration test — skipped unless VICI2_TEST_VALKEY_URL is set.
// Local run:
//   docker run -d --name v -p 26379:6379 valkey/valkey:8.0-alpine
//   VICI2_TEST_VALKEY_URL=redis://127.0.0.1:26379/0 \
//     pnpm exec tsx --test src/lib/valkey/integration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { VRedisClient } from "./client.js";

const URL = process.env.VICI2_TEST_VALKEY_URL ?? "";

async function withClient(fn: (c: VRedisClient) => Promise<void>): Promise<void> {
  if (!URL) return; // skip
  const c = await VRedisClient.create({ stateUrl: URL, tenantId: 1 });
  try {
    await c.state.flushdb();
    await c.state.script("FLUSH");
    // Re-load scripts after the flush so subsequent EVALSHAs hit.
    await c.scripts.loadAll(c.state);
    await fn(c);
  } finally {
    await c.close();
  }
}

test("integration: ping returns PONG", { skip: !URL }, async () => {
  await withClient(async (c) => {
    await c.ping();
  });
});

test("integration: NOSCRIPT auto-reload", { skip: !URL }, async () => {
  await withClient(async (c) => {
    await c.state.script("FLUSH");
    // Seed an agent then run pick_agent_for_call — script must auto-reload.
    await c.state.zadd(c.keys.agentsByCampaignStatus(42, "READY"), 1000, "7");
    await c.state.zadd(c.keys.agentsByStatus("READY"), 1000, "7");
    const res = await c.scripts.eval(
      c.state,
      "pick_agent_for_call.v1",
      [
        c.keys.agentsByCampaignStatus(42, "READY"),
        c.keys.agentsByStatus("READY"),
        c.keys.agentsByCampaignStatus(42, "RESERVED"),
        c.keys.agentsByStatus("RESERVED"),
        c.keys.agentHashPrefix(),
      ],
      ["uuid-A", "2000"],
    );
    assert.equal(res, "7");
  });
});

test("integration: claim_lead_from_hopper.v1 happy path", { skip: !URL }, async () => {
  await withClient(async (c) => {
    const cid = 42;
    await c.state.zadd(c.keys.campaignHopper(cid), 1.0, "12345");
    const res = await c.scripts.eval(
      c.state,
      "claim_lead_from_hopper.v1",
      [
        c.keys.campaignHopper(cid),
        c.keys.leadLockPrefix(cid),
        c.keys.campaignInFlight(cid),
      ],
      ["30", "instance-A", "1700000000000"],
    );
    assert.equal(res, "12345");
    const lock = await c.state.get(c.keys.leadLock(cid, 12345));
    assert.equal(lock, "instance-A:1700000000000");
  });
});

test("integration: hasBloomModule returns boolean", { skip: !URL }, async () => {
  await withClient(async (c) => {
    const r = await c.hasBloomModule();
    assert.equal(typeof r, "boolean");
  });
});
