// D06 worker — setInterval 30s main loop + SIGTERM handler.
//
// Ticks:
//   Every 30s: callbackFireTick (fire due callbacks)
//   Every 60s: callbackUpcomingTick (5-min pre-due WS notify)
//   Every 5min: callbackStaleTick (stale detection + Prometheus)

import "dotenv-flow/config";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";

import { callbackFireTick } from "./tick.js";
import { callbackUpcomingTick } from "./upcoming.js";
import { callbackStaleTick } from "./stale.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "callback-fire-worker" },
});

const prisma = new PrismaClient();
const redis = new Redis(process.env.VICI2_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379/0");

// Phase 1: single tenant (tenant_id = 1). Multi-tenant support: E01 iterates active tenants.
const TENANT_ID = BigInt(process.env.VICI2_TENANT_ID ?? 1);

let running = true;
const intervals: NodeJS.Timeout[] = [];

async function runFireTick(): Promise<void> {
  try {
    const result = await callbackFireTick(prisma, redis, TENANT_ID);
    if (!result.skipped) {
      logger.info({ ...result, tenantId: String(TENANT_ID) }, "d06:fire-tick");
    }
  } catch (err) {
    logger.error({ err }, "d06:fire-tick: uncaught error");
  }
}

async function runUpcomingTick(): Promise<void> {
  try {
    await callbackUpcomingTick(prisma, redis, TENANT_ID);
  } catch (err) {
    logger.error({ err }, "d06:upcoming-tick: uncaught error");
  }
}

async function runStaleTick(): Promise<void> {
  try {
    await callbackStaleTick(prisma, redis, TENANT_ID);
  } catch (err) {
    logger.error({ err }, "d06:stale-tick: uncaught error");
  }
}

async function main(): Promise<void> {
  logger.info({ tenantId: String(TENANT_ID) }, "d06:worker: starting");

  // Run immediately on start
  await runFireTick();
  await runUpcomingTick();
  await runStaleTick();

  // Fire tick: every 30s
  intervals.push(setInterval(() => { void runFireTick(); }, 30_000));

  // Upcoming tick: every 60s
  intervals.push(setInterval(() => { void runUpcomingTick(); }, 60_000));

  // Stale detection tick: every 5 min
  intervals.push(setInterval(() => { void runStaleTick(); }, 5 * 60_000));

  logger.info("d06:worker: running");
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  logger.info({ signal }, "d06:worker: shutting down");
  intervals.forEach(clearInterval);
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void main().catch((err) => {
  logger.error({ err }, "d06:worker: fatal startup error");
  process.exit(1);
});
