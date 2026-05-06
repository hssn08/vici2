// /metrics endpoint for the Next.js app.
// O01 will scrape this from Prometheus. Module-specific UI metrics are added
// by downstream agent / admin features.

import { NextResponse } from "next/server";
import client from "prom-client";

declare global {
  var __vici2WebRegistry: client.Registry | undefined;
  var __vici2WebHeartbeat: client.Counter<string> | undefined;
}

function getRegistry(): { registry: client.Registry; heartbeat: client.Counter<string> } {
  if (!globalThis.__vici2WebRegistry) {
    const registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry, prefix: "vici2_web_" });
    const heartbeat = new client.Counter({
      name: "vici2_web_heartbeats_total",
      help: "Number of /metrics scrapes observed.",
      registers: [registry],
    });
    new client.Gauge({
      name: "vici2_web_uptime_seconds",
      help: "Seconds since the web process started.",
      registers: [registry],
      collect() {
        this.set(process.uptime());
      },
    });
    globalThis.__vici2WebRegistry = registry;
    globalThis.__vici2WebHeartbeat = heartbeat;
  }
  return {
    registry: globalThis.__vici2WebRegistry,
    heartbeat: globalThis.__vici2WebHeartbeat as client.Counter<string>,
  };
}

export async function GET(): Promise<Response> {
  const { registry, heartbeat } = getRegistry();
  heartbeat.inc();
  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": registry.contentType },
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
